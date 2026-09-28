import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

function fakeEnv() {
  const devices = new Map();
  const pairings = new Set();
  const pairAttempts = new Map();
  const transfers = new Map();
  let object = null;
  const DB = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() {
          if (sql.includes('WHERE token_hash')) return [...devices.values()].find(d => d.token_hash === args[0]) || null;
          if (sql.includes('SELECT attempts FROM pair_attempts')) return { attempts: pairAttempts.get(args[0])?.attempts || 0 };
          if (sql.includes('WHERE pair_code_hash')) return [...devices.values()].find(d => d.pair_code_hash === args[0] && d.pair_expires_at > args[1]) || null;
          if (sql.includes('SELECT 1 FROM pairings')) return pairings.has(`${args[0]}:${args[1]}`) ? { 1: 1 } : null;
          if (sql.includes('SELECT * FROM transfers WHERE id')) {
            const transfer = transfers.get(args[0]);
            return sql.includes('receiver_device_id = ?') && transfer?.receiver_device_id !== args[1] ? null : transfer || null;
          }
          if (sql.includes('SELECT * FROM transfers')) {
            const t = transfers.get(args[0]); return t?.receiver_device_id === args[1] && t.status === 'ready' ? t : null;
          }
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO pair_attempts')) {
            const previous = pairAttempts.get(args[0]);
            pairAttempts.set(args[0], previous && previous.windowStart >= args[2]
              ? { windowStart: previous.windowStart, attempts: previous.attempts + 1 }
              : { windowStart: args[1], attempts: 1 });
          } else if (sql.includes('INSERT INTO devices')) {
            if (sql.includes('android-pwa')) devices.set(args[0], { id: args[0], name: args[1], platform: 'android-pwa', token_hash: args[2], pair_code_hash: args[3], pair_expires_at: args[4] });
            else devices.set(args[0], { id: args[0], name: 'Mac Chrome', platform: 'chrome-extension', token_hash: args[1] });
          } else if (sql.includes('INSERT INTO pairings')) pairings.add(`${args[0]}:${args[1]}`);
          else if (sql.includes('UPDATE devices SET pair_code_hash = NULL')) { const d = devices.get(args[0]); d.pair_code_hash = null; }
          else if (sql.includes('INSERT INTO transfers')) transfers.set(args[0], { id: args[0], sender_device_id: args[1], receiver_device_id: args[2], object_key: args[3], filename: args[4], mime_type: args[5], byte_size: args[6], status: 'uploading', created_at: args[7], expires_at: args[8] });
          else if (sql.includes("UPDATE transfers SET status = 'ready'")) transfers.get(args[1]).status = 'ready';
          else if (sql.includes('DELETE FROM transfers')) {
            const transfer = transfers.get(args[0]);
            if (transfer?.receiver_device_id === args[1]) transfers.delete(args[0]);
          }
          return {};
        },
        async all() {
          return { results: [...transfers.values()].filter(t => t.receiver_device_id === args[0] && t.status === 'ready')
            .map(t => ({ id: t.id, filename: t.filename, createdAt: t.created_at, senderName: 'Mac Chrome' })) };
        }
      };
    },
    async batch(statements) { for (const statement of statements) await statement.run(); }
  };
  return { DB, OBJECTS: { head: async () => object, delete: async () => { object = null; } },
    setObject(value) { object = value; }, getObject() { return object; },
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', R2_BUCKET_NAME: 'cachetray-transfers',
    R2_ACCESS_KEY_ID: 'test-access-key', R2_SECRET_ACCESS_KEY: 'test-secret-key',
    WEB_ORIGIN: 'https://cachetray.example', EXTENSION_ORIGIN: 'chrome-extension://abcdef' };
}

async function call(env, method, path, body, token, origin = 'https://cachetray.example') {
  const response = await worker.fetch(new Request(`https://worker.example${path}`, {
    method, headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  }), env);
  return { status: response.status, body: await response.json(), cors: response.headers.get('Access-Control-Allow-Origin') };
}

test('pairing, presigned upload, ready verification and phone inbox', async () => {
  const env = fakeEnv();
  const registered = await call(env, 'POST', '/api/devices/register', { name: 'Pixel 8' });
  assert.equal(registered.status, 201);
  assert.equal(registered.cors, env.WEB_ORIGIN);
  const phone = registered.body;
  assert.match(phone.pairingCode, /^[a-z]{1,5} [a-z]{1,5} [a-z]{1,5}$/);
  const paired = await call(env, 'POST', '/api/devices/pair', { code: phone.pairingCode }, null, env.EXTENSION_ORIGIN);
  assert.equal(paired.status, 201);
  const mac = paired.body;
  const begun = await call(env, 'POST', '/api/transfers', {
    receiverDeviceId: phone.deviceId, filename: 'screenshot.png', mimeType: 'image/png', type: 'image', byteSize: 3
  }, mac.senderToken, env.EXTENSION_ORIGIN);
  assert.equal(begun.status, 201);
  assert.match(begun.body.uploadUrl, /X-Amz-Signature=/);
  assert.equal(new URL(begun.body.uploadUrl).searchParams.get('X-Amz-SignedHeaders'), 'content-type;host');
  const inboxPath = `/api/devices/${phone.deviceId}/transfers`;
  assert.equal((await call(env, 'GET', inboxPath, null, phone.deviceToken)).body.transfers.length, 0);
  const readyPath = `/api/transfers/${begun.body.transferId}/ready`;
  assert.equal((await call(env, 'POST', readyPath, null, mac.senderToken)).status, 409);
  env.setObject({ size: 3, httpMetadata: { contentType: 'image/png' } });
  assert.equal((await call(env, 'POST', readyPath, null, mac.senderToken)).body.status, 'ready');
  assert.equal((await call(env, 'GET', inboxPath, null, phone.deviceToken)).body.transfers[0].filename, 'screenshot.png');
  const download = await call(env, 'GET', `/api/transfers/${begun.body.transferId}/download`, null, phone.deviceToken);
  assert.match(download.body.downloadUrl, /X-Amz-Signature=/);
  assert.equal((await call(env, 'GET', `/api/transfers/${begun.body.transferId}/download`, null, mac.senderToken)).status, 401);
  const deletePath = `/api/transfers/${begun.body.transferId}`;
  assert.equal((await call(env, 'DELETE', deletePath, null, mac.senderToken)).status, 401);
  const otherPhone = (await call(env, 'POST', '/api/devices/register', { name: 'Galaxy' })).body;
  assert.equal((await call(env, 'DELETE', deletePath, null, otherPhone.deviceToken)).status, 404);
  assert.equal(env.getObject()?.size, 3);
  assert.equal((await call(env, 'DELETE', deletePath, null, phone.deviceToken)).body.status, 'deleted');
  assert.equal(env.getObject(), null);
  assert.equal((await call(env, 'GET', inboxPath, null, phone.deviceToken)).body.transfers.length, 0);
  assert.equal((await call(env, 'GET', `/api/transfers/${begun.body.transferId}/download`, null, phone.deviceToken)).status, 404);
});

test('pair phrases accept case and hyphens, and repeated guesses are limited', async () => {
  const env = fakeEnv();
  const registered = await call(env, 'POST', '/api/devices/register', { name: 'Pixel 8' });
  const code = registered.body.pairingCode.toUpperCase().replaceAll(' ', '-');
  assert.equal((await call(env, 'POST', '/api/devices/pair', { code }, null, env.EXTENSION_ORIGIN)).status, 201);
  for (let i = 0; i < 9; i++) {
    assert.equal((await call(env, 'POST', '/api/devices/pair', { code: 'apple orange river' }, null, env.EXTENSION_ORIGIN)).status, 404);
  }
  assert.equal((await call(env, 'POST', '/api/devices/pair', { code: 'apple orange river' }, null, env.EXTENSION_ORIGIN)).status, 429);
});
