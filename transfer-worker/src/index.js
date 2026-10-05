import { AwsClient } from 'aws4fetch';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { limits, selectClips, imageUsage, reserveImage } from './plans.js';
import { effectiveDevice, billingSummary, checkout, portal, restore, webhook } from './billing.js';

const DAY = 24 * 60 * 60 * 1000;
// The extension syncs every five minutes, including when there are no new clips.
const MAC_ACTIVE_WINDOW = 12 * 60 * 1000;
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
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Vary', 'Origin');
  }
  return response;
}

async function bodyJson(request) {
  if (Number(request.headers.get('content-length')) > 4096) throw new Error('Request too large');
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 4096) throw new Error('Request too large');
  return JSON.parse(raw);
}

async function authenticate(request, env) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!token || token.length < 40) return null;
  return env.DB.prepare('SELECT id, name, platform, plan FROM devices WHERE token_hash = ?')
    .bind(await hash(token)).first();
}
const isPhone = device => device && ['android-pwa', 'ios-pwa'].includes(device.platform);
const phoneLimit = device => device?.plan === 'pro' ? 2 : 1;
async function pairingCount(env, senderId) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM pairings WHERE sender_id = ?').bind(senderId).first();
  return Number(row?.total || 0);
}
async function canUsePhone(env, sender, receiverId) {
  const rows = await env.DB.prepare('SELECT receiver_id FROM pairings WHERE sender_id = ? ORDER BY created_at DESC, receiver_id LIMIT ?')
    .bind(sender.id, phoneLimit(sender)).all();
  return rows.results.some(row => row.receiver_id === receiverId);
}
async function pairedMacs(env, receiverId) {
  const rows = await env.DB.prepare(`SELECT d.id, d.name, d.last_seen_at AS lastSeenAt
    FROM pairings p JOIN devices d ON d.id = p.sender_id
    WHERE p.receiver_id = ? ORDER BY p.created_at DESC`).bind(receiverId).all();
  const cutoff = Date.now() - MAC_ACTIVE_WINDOW;
  return (rows.results || []).map(mac => ({ ...mac, online: Number(mac.lastSeenAt) > cutoff }));
}
async function accountStatus(env, device) {
  if (device?.platform !== 'chrome-extension') return fail('Unauthorized', 401);
  await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(Date.now(), device.id).run();
  const rows = await env.DB.prepare(`SELECT d.id AS receiverDeviceId, d.name AS receiverName,
    d.last_seen_at AS lastSeenAt FROM pairings p JOIN devices d ON d.id = p.receiver_id
    WHERE p.sender_id = ? ORDER BY p.created_at DESC, p.receiver_id`).bind(device.id).all();
  return json({ plan: device.plan || 'free', maxPhones: phoneLimit(device),
    pairedPhones: rows.results.length, devices: rows.results.map((phone, index) => ({ ...phone, enabled: index < phoneLimit(device) })),
    limits: limits(device.plan, env), usage: await imageUsage(env, device.id),
    billing: await billingSummary(env, device.id) });
}
async function insertPairing(env, sender, receiverId, sessionHash = null) {
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO pairings (sender_id, receiver_id, created_at)
    SELECT ?, ?, ? WHERE ((SELECT COUNT(*) FROM pairings WHERE sender_id = ?) < ?
      OR EXISTS (SELECT 1 FROM pairings WHERE sender_id = ? AND receiver_id = ?))
    AND (? IS NULL OR EXISTS (SELECT 1 FROM connect_sessions WHERE id_hash = ? AND sender_id = ? AND receiver_id = ?))`)
    .bind(sender.id, receiverId, Date.now(), sender.id, phoneLimit(sender), sender.id, receiverId,
      sessionHash, sessionHash, sender.id, receiverId).run();
  return result.meta?.changes === 1 || Boolean(await env.DB.prepare('SELECT 1 FROM pairings WHERE sender_id = ? AND receiver_id = ?')
    .bind(sender.id, receiverId).first());
}

async function rateLimited(request, env, scope, limit = 20, identity) {
  const ipHash = await hash(`${scope}:${identity || request.headers.get('CF-Connecting-IP') || 'unknown'}`);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO pair_attempts (ip_hash, window_start, attempts) VALUES (?, ?, 1)
    ON CONFLICT(ip_hash) DO UPDATE SET
      attempts = CASE WHEN window_start < ? THEN 1 ELSE attempts + 1 END,
      window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END`)
    .bind(ipHash, now, now - 10 * 60_000, now - 10 * 60_000, now).run();
  const attempt = await env.DB.prepare('SELECT attempts FROM pair_attempts WHERE ip_hash = ?').bind(ipHash).first();
  return attempt.attempts > limit;
}

function signer(env) {
  if (!env.R2_ACCOUNT_ID || !env.R2_BUCKET_NAME || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 signing is not configured');
  }
  return new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3', region: 'auto' });
}

async function signedUrl(env, key, method, mimeType, byteSize) {
  const path = `${encodeURIComponent(env.R2_BUCKET_NAME)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const url = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${path}?X-Amz-Expires=${method === 'PUT' ? 300 : 60}`;
  const options = { method, headers: method === 'PUT' ? { 'Content-Type': mimeType, 'Content-Length': String(byteSize) } : {} };
  // aws4fetch excludes Content-Type by default; allHeaders binds PUT URLs to the declared image MIME type.
  const signed = await signer(env).sign(new Request(url, options), { aws: { signQuery: true, allHeaders: true } });
  return signed.url.toString();
}

async function register(request, env) {
  if (await rateLimited(request, env, 'register')) return fail('Too many new devices. Try again in 10 minutes.', 429);
  const body = await bodyJson(request);
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) return fail('Device name is required');
  const id = crypto.randomUUID();
  const token = randomSecret();
  const code = newPairCode();
  const now = Date.now();
  const platform = body.platform === 'ios-pwa' ? 'ios-pwa' : 'android-pwa';
  await env.DB.prepare(`INSERT INTO devices
    (id, name, platform, token_hash, pair_code_hash, pair_expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, name, platform, await hash(token), await hash(code), now + 10 * 60_000, now, now).run();
  return json({ deviceId: id, deviceToken: token, name, pairingCode: code, pairingExpiresAt: now + 10 * 60_000 }, 201);
}

async function pair(request, env, device) {
  // Never silently rotate identity if a saved credential stops authenticating.
  if (request.headers.has('Authorization') && !device) return fail('Mac identity is unavailable. Reconnect explicitly.', 401);
  const { code } = await bodyJson(request);
  if (await rateLimited(request, env, 'pair', 10)) return fail('Too many pairing attempts. Try again in 10 minutes.', 429);
  const now = Date.now();
  const normalized = normalizePairCode(code);
  if (!normalized) return fail('Enter the three words shown on your phone');
  const receiver = await env.DB.prepare('SELECT id, name FROM devices WHERE pair_code_hash = ? AND pair_expires_at > ?')
    .bind(await hash(normalized), Date.now()).first();
  if (!receiver) return fail('Pairing code expired or not found', 404);
  let senderId = device?.platform === 'chrome-extension' ? device.id : crypto.randomUUID();
  let senderToken = device?.platform === 'chrome-extension'
    ? request.headers.get('Authorization')?.slice(7) : randomSecret();
  if (device && device.platform !== 'chrome-extension') return fail('Unauthorized', 401);
  if (device && await pairingCount(env, senderId) >= phoneLimit(device)
    && !await env.DB.prepare('SELECT 1 FROM pairings WHERE sender_id = ? AND receiver_id = ?').bind(senderId, receiver.id).first())
    return fail(`Your ${device.plan === 'pro' ? 'Pro' : 'Free'} plan allows ${phoneLimit(device)} paired phone${phoneLimit(device) === 1 ? '' : 's'}. Disconnect one first.`, 403);
  if (!device) {
    await env.DB.prepare(`INSERT INTO devices (id, name, platform, token_hash, created_at, last_seen_at)
      VALUES (?, 'Mac Chrome', 'chrome-extension', ?, ?, ?)`).bind(senderId, await hash(senderToken), now, now).run();
    device = { id: senderId, platform: 'chrome-extension', plan: 'free' };
  }
  if (!await insertPairing(env, device, receiver.id)) return fail('Phone limit reached. Disconnect a phone first.', 403);
  await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(now, senderId).run();
  await env.DB.prepare('UPDATE devices SET pair_code_hash = NULL, pair_expires_at = NULL WHERE id = ?').bind(receiver.id).run();
  return json({ senderDeviceId: senderId, senderToken, receiverDeviceId: receiver.id,
    receiverName: receiver.name }, 201);
}

async function refreshPairCode(request, env, device) {
  if (!isPhone(device)) return fail('Unauthorized', 401);
  const code = newPairCode();
  const expiresAt = Date.now() + 10 * 60_000;
  await env.DB.prepare('UPDATE devices SET pair_code_hash = ?, pair_expires_at = ? WHERE id = ?')
    .bind(await hash(code), expiresAt, device.id).run();
  return json({ pairingCode: code, pairingExpiresAt: expiresAt });
}

async function startConnect(request, env, device) {
  if (request.headers.has('Authorization') && !device) return fail('Mac identity is unavailable. Reconnect explicitly.', 401);
  if (await rateLimited(request, env, 'connect')) return fail('Too many QR codes. Try again in 10 minutes.', 429);
  // A short-lived, single-use QR capability. The secret stays in the URL fragment,
  // so opening the page does not send it in an HTTP request or referrer.
  const id = randomSecret();
  if (device && device.platform !== 'chrome-extension') return fail('Unauthorized', 401);
  if (device && await pairingCount(env, device.id) >= phoneLimit(device))
    return fail(`Your ${device.plan === 'pro' ? 'Pro' : 'Free'} plan allows ${phoneLimit(device)} paired phone${phoneLimit(device) === 1 ? '' : 's'}. Disconnect one first.`, 403);
  const senderId = device?.id || crypto.randomUUID();
  const senderToken = device ? request.headers.get('Authorization')?.slice(7) : randomSecret();
  const now = Date.now();
  if (!device) await env.DB.prepare(`INSERT INTO devices (id, name, platform, token_hash, created_at, last_seen_at)
    VALUES (?, 'Mac Chrome', 'chrome-extension', ?, ?, ?)`).bind(senderId, await hash(senderToken), now, now).run();
  await env.DB.prepare('INSERT INTO connect_sessions (id_hash, sender_id, expires_at) VALUES (?, ?, ?)')
    .bind(await hash(id), senderId, now + 10 * 60_000).run();
  return json({ connectId: id, senderDeviceId: senderId, senderToken,
    connectUrl: `${env.WEB_ORIGIN}/received.html#connect=${encodeURIComponent(id)}`, expiresAt: now + 10 * 60_000 }, 201);
}

async function claimConnect(request, env, device) {
  if (!isPhone(device)) return fail('Unauthorized', 401);
  const id = String((await bodyJson(request)).connectId || '');
  if (!/^[a-f0-9]{64}$/.test(id)) return fail('Invalid connection code');
  const idHash = await hash(id);
  const pending = await env.DB.prepare('SELECT sender_id FROM connect_sessions WHERE id_hash = ? AND receiver_id IS NULL AND expires_at > ?')
    .bind(idHash, Date.now()).first();
  if (!pending) return fail('QR code expired or already used', 410);
  let sender = await env.DB.prepare('SELECT id, plan, platform FROM devices WHERE id = ? AND platform = ?')
    .bind(pending.sender_id, 'chrome-extension').first();
  sender = await effectiveDevice(env, sender);
  if (!sender) return fail('Mac is unavailable', 404);
  if (await pairingCount(env, sender.id) >= phoneLimit(sender)
    && !await env.DB.prepare('SELECT 1 FROM pairings WHERE sender_id = ? AND receiver_id = ?').bind(sender.id, device.id).first())
    return fail('Phone limit reached on this Mac. Disconnect a phone first.', 403);
  const result = await env.DB.prepare(`UPDATE connect_sessions SET receiver_id = ?
    WHERE id_hash = ? AND receiver_id IS NULL AND expires_at > ?`)
    .bind(device.id, idHash, Date.now()).run();
  if (result.meta?.changes !== 1) return fail('QR code expired or already used', 410);
  if (!await insertPairing(env, sender, device.id, idHash)) {
    await env.DB.prepare('UPDATE connect_sessions SET receiver_id = NULL WHERE id_hash = ? AND receiver_id = ?').bind(idHash, device.id).run();
    return fail('Phone limit reached on this Mac. Disconnect a phone first.', 403);
  }
  await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(Date.now(), sender.id).run();
  return json({ connected: true });
}

async function connectStatus(env, device, id) {
  if (!device || device.platform !== 'chrome-extension' || !/^[a-f0-9]{64}$/.test(id)) return fail('Unauthorized', 401);
  const session = await env.DB.prepare(`SELECT s.receiver_id, s.expires_at, d.name AS receiver_name
    FROM connect_sessions s LEFT JOIN devices d ON d.id = s.receiver_id
    WHERE s.id_hash = ? AND s.sender_id = ?`).bind(await hash(id), device.id).first();
  if (!session) return fail('Connection not found', 404);
  if (session.receiver_id) {
    const paired = await env.DB.prepare('SELECT 1 FROM pairings WHERE sender_id = ? AND receiver_id = ?')
      .bind(device.id, session.receiver_id).first();
    if (paired) return json({ connected: true, receiverDeviceId: session.receiver_id,
      receiverName: session.receiver_name });
  }
  return json({ connected: false, expired: session.expires_at <= Date.now() });
}

async function putClips(request, env, device, receiverId) {
  if (!device || device.platform !== 'chrome-extension') return fail('Unauthorized', 401);
  if (await rateLimited(request, env, 'clip-write', 120, device.id)) return fail('Clip sync is temporarily rate limited. Try again shortly.', 429);
  const paired = await env.DB.prepare('SELECT 1 FROM pairings WHERE sender_id = ? AND receiver_id = ?')
    .bind(device.id, receiverId).first();
  if (!paired) return fail('Phone is not paired', 403);
  if (!await canUsePhone(env, device, receiverId)) return fail('Free allows one active phone. Upgrade or disconnect the other phone.', 403);
  if (Number(request.headers.get('content-length')) > 250_000) return fail('Clip sync is too large', 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 250_000) return fail('Clip sync is too large', 413);
  const body = JSON.parse(raw);
  if (!Array.isArray(body.items) || body.items.length > 800) return fail('Too many clips');
  const now = Date.now();
  const allowed = new Set(['text', 'code', 'link', 'task']);
  const candidates = body.items.filter(item => item && allowed.has(item.type)
    && Number.isFinite(item.time) && item.time > now - DAY && item.time <= now + 60_000)
    .map(item => ({ id: String(item.id).slice(0, 80), type: item.type, time: item.time,
      content: String(item.content || '').slice(0, 10_000), full: String(item.full || '').slice(0, 20_000),
      url: String(item.url || '').slice(0, 2_000), done: item.done === true }));
  const cap = limits(device.plan, env).clipsPerCategory;
  const items = selectClips(candidates, cap);
  await env.DB.prepare(`INSERT INTO clip_snapshots (sender_id, receiver_id, payload, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(sender_id, receiver_id) DO UPDATE SET payload = excluded.payload,
      updated_at = excluded.updated_at, expires_at = excluded.expires_at`)
    .bind(device.id, receiverId, JSON.stringify(items), now, now + DAY).run();
  await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(now, device.id).run();
  return json({ synced: items.length, clipped: candidates.length - items.length, clipsPerCategory: cap });
}

async function getClips(env, device, receiverId) {
  if (!isPhone(device) || device.id !== receiverId) return fail('Unauthorized', 401);
  const rows = await env.DB.prepare(`SELECT s.sender_id, s.payload, d.name AS sender_name, d.plan
    FROM clip_snapshots s JOIN devices d ON d.id = s.sender_id
    JOIN pairings p ON p.sender_id = s.sender_id AND p.receiver_id = s.receiver_id
    WHERE s.receiver_id = ? AND s.expires_at > ?`).bind(receiverId, Date.now()).all();
  const cutoff = Date.now() - DAY;
  const items = [];
  const plans = [];
  for (const row of rows.results || []) {
    const sender = await effectiveDevice(env, { id: row.sender_id, plan: row.plan, platform: 'chrome-extension' });
    if (!await canUsePhone(env, sender, receiverId)) continue;
    const cap = limits(sender.plan, env).clipsPerCategory;
    plans.push({ senderId: row.sender_id, plan: sender.plan || 'free', clipsPerCategory: cap });
    items.push(...selectClips(JSON.parse(row.payload).filter(item => item.time > cutoff), cap)
      .map(item => ({ ...item, senderId: row.sender_id, senderName: row.sender_name })));
  }
  items.sort((a, b) => b.time - a.time);
  // The PWA shows one merged inbox. Apply one category cap after merging senders,
  // otherwise pairing several free Macs would multiply the phone's allowance.
  const inboxCap = plans.some(plan => plan.plan === 'pro')
    ? limits('pro', env).clipsPerCategory : limits('free', env).clipsPerCategory;
  return json({ items: selectClips(items, inboxCap), pairedMacs: await pairedMacs(env, receiverId), plans,
    clipsPerCategory: inboxCap });
}

async function disconnectPhone(env, device, receiverId, senderId = device?.id) {
  const authorized = device?.platform === 'chrome-extension' ? device.id === senderId
    : isPhone(device) && device.id === receiverId;
  if (!authorized) return fail('Unauthorized', 401);
  const paired = await env.DB.prepare('SELECT 1 FROM pairings WHERE sender_id = ? AND receiver_id = ?')
    .bind(senderId, receiverId).first();
  if (!paired && isPhone(device)) return json({ disconnected: true });
  // Idempotent, and revoke pending QR sessions too: a delayed claim must not reconnect it.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM clip_snapshots WHERE sender_id = ? AND receiver_id = ?').bind(senderId, receiverId),
    env.DB.prepare('DELETE FROM pairings WHERE sender_id = ? AND receiver_id = ?').bind(senderId, receiverId),
    env.DB.prepare('DELETE FROM connect_sessions WHERE sender_id = ? AND (receiver_id = ? OR receiver_id IS NULL)').bind(senderId, receiverId)
  ]);
  return json({ disconnected: true });
}

async function startTransfer(request, env, device) {
  if (!device || device.platform !== 'chrome-extension') return fail('Unauthorized', 401);
  if (await rateLimited(request, env, 'image-upload', 60, device.id)) return fail('Too many image upload attempts. Try again shortly.', 429);
  const body = await bodyJson(request);
  const receiverId = String(body.receiverDeviceId || '');
  const paired = await env.DB.prepare('SELECT 1 FROM pairings WHERE sender_id = ? AND receiver_id = ?')
    .bind(device.id, receiverId).first();
  if (!paired) return fail('Phone is not paired', 403);
  if (!await canUsePhone(env, device, receiverId)) return fail('Free allows one active phone. Upgrade or disconnect the other phone.', 403);
  const mimeType = String(body.mimeType || '');
  const byteSize = Number(body.byteSize);
  if (body.type !== 'image' || !MIME_TYPES.has(mimeType)) return fail('Unsupported image type');
  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MAX_BYTES) return fail('Image must be 1 byte–20 MB');
  const filename = String(body.filename || 'image').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 120);
  const id = crypto.randomUUID();
  const objectKey = `transfers/${id}`;
  const now = Date.now();
  const uploadUrl = await signedUrl(env, objectKey, 'PUT', mimeType, byteSize);
  if (!await reserveImage(env, device, receiverId, id, now)) return json({ error: device.plan === 'pro'
    ? `Your phone can hold ${limits(device.plan, env).imagesPerPhone} images at once. Delete an image or wait for one to expire.`
    : 'Free allows 5 image sends in any 24 hours. Deleting received images does not reset this allowance. Upgrade to Pro or wait for your allowance to renew.',
    code: device.plan === 'pro' ? 'IMAGE_LIMIT' : 'DAILY_IMAGE_LIMIT', limits: limits(device.plan, env), usage: await imageUsage(env, device.id) }, 403);
  try {
    await env.DB.prepare(`INSERT INTO transfers
    (id, sender_device_id, receiver_device_id, object_key, type, filename, mime_type, byte_size, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, 'image', ?, ?, ?, 'uploading', ?, ?)`)
    .bind(id, device.id, receiverId, objectKey, filename, mimeType, byteSize, now, now + DAY).run();
  } catch (error) {
    await env.DB.prepare("DELETE FROM image_usage WHERE transfer_id = ? AND status = 'reserved'").bind(id).run();
    throw error;
  }
  return json({ transferId: id, uploadUrl }, 201);
}

async function markReady(env, device, id) {
  if (!device || device.platform !== 'chrome-extension') return fail('Unauthorized', 401);
  const transfer = await env.DB.prepare('SELECT * FROM transfers WHERE id = ? AND sender_device_id = ?')
    .bind(id, device.id).first();
  if (!transfer) return fail('Transfer not found', 404);
  if (transfer.expires_at <= Date.now()) return fail('Transfer expired', 410);
  if (transfer.status === 'ready') return json({ status: 'ready' });
  const reservation = await env.DB.prepare("SELECT transfer_id FROM image_usage WHERE transfer_id = ? AND sender_id = ? AND status = 'reserved' AND reserved_until > ?")
    .bind(id, device.id, Date.now()).first();
  if (!reservation) return fail('Upload allowance expired. Please send the image again.', 410);
  const object = await env.OBJECTS.head(transfer.object_key);
  if (!object || object.size !== transfer.byte_size || object.httpMetadata?.contentType !== transfer.mime_type) {
    return fail('Upload is missing or does not match the selected image', 409);
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE image_usage SET status = 'sent', sent_at = ? WHERE transfer_id = ? AND status = 'reserved' AND reserved_until > ?")
      .bind(Date.now(), id, Date.now()),
    env.DB.prepare(`UPDATE transfers SET status = 'ready', ready_at = ? WHERE id = ? AND status = 'uploading'
      AND EXISTS (SELECT 1 FROM image_usage WHERE transfer_id = ? AND status = 'sent')`).bind(Date.now(), id, id)
  ]);
  const ready = await env.DB.prepare('SELECT * FROM transfers WHERE id = ? AND sender_device_id = ?').bind(id, device.id).first();
  if (ready?.status !== 'ready') return fail('Upload allowance expired. Please send the image again.', 410);
  return json({ status: 'ready' });
}

async function abortTransfer(env, device, id) {
  if (device?.platform !== 'chrome-extension') return fail('Unauthorized', 401);
  const transfer = await env.DB.prepare('SELECT * FROM transfers WHERE id = ? AND sender_device_id = ?').bind(id, device.id).first();
  if (!transfer || transfer.sender_device_id !== device.id) return fail('Transfer not found', 404);
  if (transfer.status === 'ready') return fail('Transfer was already sent', 409);
  // Cancel only unsent reservations. R2 lifecycle removes any partially completed upload.
  await env.DB.prepare("DELETE FROM image_usage WHERE transfer_id = ? AND sender_id = ? AND status = 'reserved'")
    .bind(id, device.id).run();
  return json({ cancelled: true });
}

async function inbox(env, device, id) {
  if (!isPhone(device) || device.id !== id) return fail('Unauthorized', 401);
  const rows = await env.DB.prepare(`SELECT t.id, t.filename, t.mime_type AS mimeType, t.byte_size AS byteSize,
      t.created_at AS createdAt, t.expires_at AS expiresAt, d.name AS senderName
      FROM transfers t JOIN devices d ON d.id = t.sender_device_id
      WHERE t.receiver_device_id = ? AND t.status = 'ready' AND t.expires_at > ?
      ORDER BY t.created_at DESC LIMIT 2000`).bind(id, Date.now()).all();
  await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(Date.now(), id).run();
  return json({ transfers: rows.results || [], pairedMacs: await pairedMacs(env, id) });
}

async function download(env, device, id) {
  if (!isPhone(device)) return fail('Unauthorized', 401);
  const transfer = await env.DB.prepare(`SELECT * FROM transfers
    WHERE id = ? AND receiver_device_id = ? AND status = 'ready' AND expires_at > ?`)
    .bind(id, device.id, Date.now()).first();
  if (!transfer) return fail('Transfer unavailable or expired', 404);
  return json({ downloadUrl: await signedUrl(env, transfer.object_key, 'GET'),
    filename: transfer.filename, mimeType: transfer.mime_type });
}

async function deleteTransfer(env, device, id) {
  if (!isPhone(device)) return fail('Unauthorized', 401);
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
      if (request.method === 'POST' && url.pathname === '/api/billing/webhook') return await webhook(request, env);
      const device = await effectiveDevice(env, await authenticate(request, env));
      let response;
      if (request.method === 'POST' && ['/api/billing/checkout', '/api/billing/restore', '/api/billing/portal'].includes(url.pathname)) {
        if (await rateLimited(request, env, 'billing', 10)) response = fail('Too many billing requests. Try again in 10 minutes.', 429);
        else response = url.pathname.endsWith('/checkout') ? await checkout(request, env, device)
          : url.pathname.endsWith('/restore') ? await restore(request, env, device) : await portal(env, device);
        return cors(response, origin, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/devices/register') response = await register(request, env);
      else if (request.method === 'GET' && url.pathname === '/api/devices/me') response = await accountStatus(env, device);
      else if (request.method === 'POST' && url.pathname === '/api/devices/pair') response = await pair(request, env, device);
      else if (request.method === 'POST' && url.pathname === '/api/connect/start') response = await startConnect(request, env, device);
      else if (request.method === 'POST' && url.pathname === '/api/connect/claim') response = await claimConnect(request, env, device);
      else if (request.method === 'GET' && /^\/api\/connect\/[a-f0-9]{64}$/.test(url.pathname))
        response = await connectStatus(env, device, url.pathname.split('/')[3]);
      else if (request.method === 'POST' && /^\/api\/devices\/[^/]+\/pair-code$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3];
        response = device?.id === id ? await refreshPairCode(request, env, device) : fail('Unauthorized', 401);
      } else if (request.method === 'POST' && url.pathname === '/api/transfers') response = await startTransfer(request, env, device);
      else if (request.method === 'POST' && /^\/api\/transfers\/[^/]+\/ready$/.test(url.pathname))
        response = await markReady(env, device, url.pathname.split('/')[3]);
      else if (request.method === 'POST' && /^\/api\/transfers\/[^/]+\/abort$/.test(url.pathname))
        response = await abortTransfer(env, device, url.pathname.split('/')[3]);
      else if (request.method === 'GET' && /^\/api\/devices\/[^/]+\/transfers$/.test(url.pathname))
        response = await inbox(env, device, url.pathname.split('/')[3]);
      else if (request.method === 'PUT' && /^\/api\/devices\/[^/]+\/clips$/.test(url.pathname))
        response = await putClips(request, env, device, url.pathname.split('/')[3]);
      else if (request.method === 'GET' && /^\/api\/devices\/[^/]+\/clips$/.test(url.pathname))
        response = await getClips(env, device, url.pathname.split('/')[3]);
      else if (request.method === 'DELETE' && /^\/api\/devices\/[^/]+\/pairing$/.test(url.pathname))
        response = await disconnectPhone(env, device, url.pathname.split('/')[3]);
      else if (request.method === 'DELETE' && /^\/api\/devices\/[^/]+\/pairings\/[^/]+$/.test(url.pathname))
        response = isPhone(device) ? await disconnectPhone(env, device, url.pathname.split('/')[3], url.pathname.split('/')[5]) : fail('Unauthorized', 401);
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
  },
  async scheduled(_event, env) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM clip_snapshots WHERE expires_at <= ?').bind(now),
      env.DB.prepare('DELETE FROM connect_sessions WHERE expires_at <= ?').bind(now),
      env.DB.prepare('DELETE FROM pair_attempts WHERE window_start <= ?').bind(now - DAY),
      env.DB.prepare("DELETE FROM image_usage WHERE status = 'reserved' AND reserved_until < ?").bind(now - DAY),
      env.DB.prepare("DELETE FROM image_usage WHERE status = 'sent' AND sent_at <= ?").bind(now - DAY),
      env.DB.prepare(`DELETE FROM devices WHERE platform = 'chrome-extension' AND created_at <= ?
        AND id NOT IN (SELECT sender_id FROM pairings)
        AND id NOT IN (SELECT sender_device_id FROM transfers)
        AND id NOT IN (SELECT sender_id FROM image_usage)
        AND id NOT IN (SELECT sender_id FROM billing_checkouts)
        AND id NOT IN (SELECT sender_id FROM billing_subscriptions)
        AND id NOT IN (SELECT sender_id FROM connect_sessions)`).bind(now - DAY)
    ]);
  }
};
