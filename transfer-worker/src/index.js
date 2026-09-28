import { AwsClient } from 'aws4fetch';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const DAY = 24 * 60 * 60 * 1000;
const MAX_BYTES = 20 * 1024 * 1024;
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const SHORT_WORDS = wordlist.filter(word => word.length <= 5);

const randomSecret = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const hash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  byte => byte.toString(16).padStart(2, '0')).join('');
function newPairCode() {
  const choices = crypto.getRandomValues(new Uint16Array(3));
  return Array.from(choices, value => SHORT_WORDS[value % SHORT_WORDS.length]).join(' ');
}
function normalizePairCode(value) {
  const input = String(value || '').trim();
  const legacy = input.replace(/[\s-]/g, '').toUpperCase();
  if (/^[A-F0-9]{20}$/.test(legacy)) return legacy;
  const words = input.toLowerCase().split(/[\s-]+/);
  return words.length === 3 && words.every(word => wordlist.includes(word)) ? words.join(' ') : null;
}
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (message, status = 400) => json({ error: message }, status);

function cors(response, origin, env) {
  if (origin && (origin === env.WEB_ORIGIN || origin === env.EXTENSION_ORIGIN)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    response.headers.set('Vary', 'Origin');
  }
  return response;
}

async function bodyJson(request) {
  if (Number(request.headers.get('content-length')) > 4096) throw new Error('Request too large');
  return request.json();
}

async function authenticate(request, env) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!token || token.length < 40) return null;
  return env.DB.prepare('SELECT id, name, platform FROM devices WHERE token_hash = ?')
    .bind(await hash(token)).first();
}

function signer(env) {
  if (!env.R2_ACCOUNT_ID || !env.R2_BUCKET_NAME || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 signing is not configured');
  }
  return new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3', region: 'auto' });
}

async function signedUrl(env, key, method, mimeType) {
  const path = `${encodeURIComponent(env.R2_BUCKET_NAME)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const url = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${path}?X-Amz-Expires=${method === 'PUT' ? 300 : 60}`;
  const options = { method, headers: method === 'PUT' ? { 'Content-Type': mimeType } : {} };
  // aws4fetch excludes Content-Type by default; allHeaders binds PUT URLs to the declared image MIME type.
  const signed = await signer(env).sign(new Request(url, options), { aws: { signQuery: true, allHeaders: true } });
  return signed.url.toString();
}

async function register(request, env) {
  const body = await bodyJson(request);
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) return fail('Device name is required');
  const id = crypto.randomUUID();
  const token = randomSecret();
  const code = newPairCode();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO devices
    (id, name, platform, token_hash, pair_code_hash, pair_expires_at, created_at, last_seen_at)
    VALUES (?, ?, 'android-pwa', ?, ?, ?, ?, ?)`).bind(id, name, await hash(token), await hash(code), now + 10 * 60_000, now, now).run();
  return json({ deviceId: id, deviceToken: token, name, pairingCode: code, pairingExpiresAt: now + 10 * 60_000 }, 201);
}

async function pair(request, env) {
  const { code } = await bodyJson(request);
  const ipHash = await hash(request.headers.get('CF-Connecting-IP') || 'unknown');
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO pair_attempts (ip_hash, window_start, attempts) VALUES (?, ?, 1)
    ON CONFLICT(ip_hash) DO UPDATE SET
      attempts = CASE WHEN window_start < ? THEN 1 ELSE attempts + 1 END,
      window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END`)
    .bind(ipHash, now, now - 10 * 60_000, now - 10 * 60_000, now).run();
  const attempt = await env.DB.prepare('SELECT attempts FROM pair_attempts WHERE ip_hash = ?').bind(ipHash).first();
  if (attempt.attempts > 10) return fail('Too many pairing attempts. Try again in 10 minutes.', 429);
  const normalized = normalizePairCode(code);
  if (!normalized) return fail('Enter the three words shown on your phone');
  const receiver = await env.DB.prepare('SELECT id, name FROM devices WHERE pair_code_hash = ? AND pair_expires_at > ?')
    .bind(await hash(normalized), Date.now()).first();
  if (!receiver) return fail('Pairing code expired or not found', 404);
  const senderId = crypto.randomUUID();
  const senderToken = randomSecret();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO devices (id, name, platform, token_hash, created_at, last_seen_at)
      VALUES (?, 'Mac Chrome', 'chrome-extension', ?, ?, ?)`).bind(senderId, await hash(senderToken), now, now),
    env.DB.prepare('INSERT INTO pairings (sender_id, receiver_id, created_at) VALUES (?, ?, ?)')
      .bind(senderId, receiver.id, now),
    env.DB.prepare('UPDATE devices SET pair_code_hash = NULL, pair_expires_at = NULL WHERE id = ?').bind(receiver.id)
  ]);
  return json({ senderDeviceId: senderId, senderToken, receiverDeviceId: receiver.id,
    receiverName: receiver.name }, 201);
}

async function refreshPairCode(request, env, device) {
  if (!device || device.platform !== 'android-pwa') return fail('Unauthorized', 401);
  const code = newPairCode();
  const expiresAt = Date.now() + 10 * 60_000;
  await env.DB.prepare('UPDATE devices SET pair_code_hash = ?, pair_expires_at = ? WHERE id = ?')
    .bind(await hash(code), expiresAt, device.id).run();
  return json({ pairingCode: code, pairingExpiresAt: expiresAt });
}

async function startTransfer(request, env, device) {
  if (!device || device.platform !== 'chrome-extension') return fail('Unauthorized', 401);
  const body = await bodyJson(request);
  const receiverId = String(body.receiverDeviceId || '');
  const paired = await env.DB.prepare('SELECT 1 FROM pairings WHERE sender_id = ? AND receiver_id = ?')
    .bind(device.id, receiverId).first();
  if (!paired) return fail('Phone is not paired', 403);
  const mimeType = String(body.mimeType || '');
  const byteSize = Number(body.byteSize);
  if (body.type !== 'image' || !MIME_TYPES.has(mimeType)) return fail('Unsupported image type');
  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MAX_BYTES) return fail('Image must be 1 byte–20 MB');
  const filename = String(body.filename || 'image').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 120);
  const id = crypto.randomUUID();
  const objectKey = `transfers/${id}`;
  const now = Date.now();
  const uploadUrl = await signedUrl(env, objectKey, 'PUT', mimeType);
  await env.DB.prepare(`INSERT INTO transfers
    (id, sender_device_id, receiver_device_id, object_key, type, filename, mime_type, byte_size, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, 'image', ?, ?, ?, 'uploading', ?, ?)`)
    .bind(id, device.id, receiverId, objectKey, filename, mimeType, byteSize, now, now + DAY).run();
  return json({ transferId: id, uploadUrl }, 201);
}

async function markReady(env, device, id) {
  if (!device || device.platform !== 'chrome-extension') return fail('Unauthorized', 401);
  const transfer = await env.DB.prepare('SELECT * FROM transfers WHERE id = ? AND sender_device_id = ?')
    .bind(id, device.id).first();
  if (!transfer) return fail('Transfer not found', 404);
  if (transfer.expires_at <= Date.now()) return fail('Transfer expired', 410);
  if (transfer.status === 'ready') return json({ status: 'ready' });
  const object = await env.OBJECTS.head(transfer.object_key);
  if (!object || object.size !== transfer.byte_size || object.httpMetadata?.contentType !== transfer.mime_type) {
    return fail('Upload is missing or does not match the selected image', 409);
  }
  await env.DB.prepare("UPDATE transfers SET status = 'ready', ready_at = ? WHERE id = ? AND status = 'uploading'")
    .bind(Date.now(), id).run();
  return json({ status: 'ready' });
}

async function inbox(env, device, id) {
  if (!device || device.platform !== 'android-pwa' || device.id !== id) return fail('Unauthorized', 401);
  const rows = await env.DB.prepare(`SELECT t.id, t.filename, t.mime_type AS mimeType, t.byte_size AS byteSize,
      t.created_at AS createdAt, t.expires_at AS expiresAt, d.name AS senderName
      FROM transfers t JOIN devices d ON d.id = t.sender_device_id
      WHERE t.receiver_device_id = ? AND t.status = 'ready' AND t.expires_at > ?
      ORDER BY t.created_at DESC LIMIT 100`).bind(id, Date.now()).all();
  await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(Date.now(), id).run();
  return json({ transfers: rows.results || [] });
}

async function download(env, device, id) {
  if (!device || device.platform !== 'android-pwa') return fail('Unauthorized', 401);
  const transfer = await env.DB.prepare(`SELECT * FROM transfers
    WHERE id = ? AND receiver_device_id = ? AND status = 'ready' AND expires_at > ?`)
    .bind(id, device.id, Date.now()).first();
  if (!transfer) return fail('Transfer unavailable or expired', 404);
  return json({ downloadUrl: await signedUrl(env, transfer.object_key, 'GET'),
    filename: transfer.filename, mimeType: transfer.mime_type });
}

async function deleteTransfer(env, device, id) {
  if (!device || device.platform !== 'android-pwa') return fail('Unauthorized', 401);
  const transfer = await env.DB.prepare('SELECT * FROM transfers WHERE id = ? AND receiver_device_id = ?')
    .bind(id, device.id).first();
  if (!transfer) return fail('Transfer not found', 404);
  // Delete the temporary cloud copy first. If R2 fails, keep the record so the phone can retry.
  await env.OBJECTS.delete(transfer.object_key);
  await env.DB.prepare('DELETE FROM transfers WHERE id = ? AND receiver_device_id = ?')
    .bind(id, device.id).run();
  return json({ status: 'deleted' });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), origin, env);
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return fail('Not found', 404);
    try {
      const device = await authenticate(request, env);
      let response;
      if (request.method === 'POST' && url.pathname === '/api/devices/register') response = await register(request, env);
      else if (request.method === 'POST' && url.pathname === '/api/devices/pair') response = await pair(request, env);
      else if (request.method === 'POST' && /^\/api\/devices\/[^/]+\/pair-code$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3];
        response = device?.id === id ? await refreshPairCode(request, env, device) : fail('Unauthorized', 401);
      } else if (request.method === 'POST' && url.pathname === '/api/transfers') response = await startTransfer(request, env, device);
      else if (request.method === 'POST' && /^\/api\/transfers\/[^/]+\/ready$/.test(url.pathname))
        response = await markReady(env, device, url.pathname.split('/')[3]);
      else if (request.method === 'GET' && /^\/api\/devices\/[^/]+\/transfers$/.test(url.pathname))
        response = await inbox(env, device, url.pathname.split('/')[3]);
      else if (request.method === 'GET' && /^\/api\/transfers\/[^/]+\/download$/.test(url.pathname))
        response = await download(env, device, url.pathname.split('/')[3]);
      else if (request.method === 'DELETE' && /^\/api\/transfers\/[^/]+$/.test(url.pathname))
        response = await deleteTransfer(env, device, url.pathname.split('/')[3]);
      else response = fail('Not found', 404);
      return cors(response, origin, env);
    } catch (error) {
      console.error('Transfer API failed', error);
      return cors(fail('Transfer service error', 500), origin, env);
    }
  }
};
