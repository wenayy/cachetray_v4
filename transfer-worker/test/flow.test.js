import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

import { fakeEnv } from './sqlite-env.js';

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
  assert.equal(new URL(begun.body.uploadUrl).searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host');
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

test('QR pairing is one-use and syncs only recent non-image clips to its phone', async () => {
  const env = fakeEnv();
  const start = await call(env, 'POST', '/api/connect/start');
  assert.equal(start.status, 201);
  const session = start.body;
  assert.match(session.connectUrl, /#connect=[a-f0-9]{64}$/);
  const phone = (await call(env, 'POST', '/api/devices/register', { name: 'Pixel' })).body;
  const statusPath = `/api/connect/${session.connectId}`;
  assert.equal((await call(env, 'GET', statusPath, null, session.senderToken)).body.connected, false);
  assert.equal((await call(env, 'POST', '/api/connect/claim', { connectId: session.connectId }, phone.deviceToken)).body.connected, true);
  assert.equal((await call(env, 'POST', '/api/connect/claim', { connectId: session.connectId }, phone.deviceToken)).status, 410);
  assert.equal((await call(env, 'GET', statusPath, null, session.senderToken)).body.receiverDeviceId, phone.deviceId);
  const clipsPath = `/api/devices/${phone.deviceId}/clips`;
  const items = [
    { id: 1, type: 'text', content: 'hello', time: Date.now() },
    { id: 2, type: 'image', content: 'data:image/png;base64,secret', time: Date.now() },
    { id: 3, type: 'link', content: 'old', time: Date.now() - 2 * 86400000 }
  ];
  assert.equal((await call(env, 'PUT', clipsPath, { items }, session.senderToken)).body.synced, 1);
  assert.equal((await call(env, 'GET', clipsPath, null, phone.deviceToken)).body.items[0].content, 'hello');
  assert.equal((await call(env, 'GET', clipsPath, null, session.senderToken)).status, 401);
  const otherPhone = (await call(env, 'POST', '/api/devices/register', { name: 'Other' })).body;
  assert.equal((await call(env, 'GET', clipsPath, null, otherPhone.deviceToken)).status, 401);
  const disconnectPath = `/api/devices/${phone.deviceId}/pairing`;
  assert.equal((await call(env, 'DELETE', disconnectPath, null, otherPhone.deviceToken)).status, 401);
  assert.equal((await call(env, 'DELETE', disconnectPath, null, session.senderToken)).body.disconnected, true);
  assert.equal((await call(env, 'GET', clipsPath, null, phone.deviceToken)).body.items.length, 0);
  assert.equal((await call(env, 'PUT', clipsPath, { items }, session.senderToken)).status, 403);
});

test('Free Mac can pair one phone; server-controlled Pro plan can pair two', async () => {
  const env = fakeEnv();
  const first = (await call(env, 'POST', '/api/devices/register', { name: 'Pixel', platform: 'android-pwa' })).body;
  const mac = (await call(env, 'POST', '/api/devices/pair', { code: first.pairingCode })).body;
  const second = (await call(env, 'POST', '/api/devices/register', { name: 'iPhone', platform: 'ios-pwa' })).body;
  const free = await call(env, 'POST', '/api/devices/pair', { code: second.pairingCode }, mac.senderToken, env.EXTENSION_ORIGIN);
  assert.equal(free.status, 403);
  const account = await call(env, 'GET', '/api/devices/me', null, mac.senderToken, env.EXTENSION_ORIGIN);
  assert.equal(account.body.plan, 'free');
  assert.equal(account.body.maxPhones, 1);
  assert.equal(account.body.pairedPhones, 1);
  assert.equal(account.body.devices[0].receiverDeviceId, first.deviceId);
  env.setPlan(mac.senderDeviceId, 'pro');
  const pro = await call(env, 'POST', '/api/devices/pair', { code: second.pairingCode }, mac.senderToken, env.EXTENSION_ORIGIN);
  assert.equal(pro.status, 201);
  assert.equal(pro.body.senderDeviceId, mac.senderDeviceId);
  assert.equal((await call(env, 'GET', `/api/devices/${second.deviceId}/transfers`, null, second.deviceToken)).status, 200);
  const third = (await call(env, 'POST', '/api/devices/register', { name: 'Galaxy' })).body;
  assert.equal((await call(env, 'POST', '/api/devices/pair', { code: third.pairingCode }, mac.senderToken)).status, 403);
});

test('re-pairing the same Mac reuses its identity, and disconnect immediately clears phone status', async () => {
  const env = fakeEnv();
  const phone = (await call(env, 'POST', '/api/devices/register', { name: 'Pixel' })).body;
  const mac = (await call(env, 'POST', '/api/devices/pair', { code: phone.pairingCode })).body;
  const phrase = (await call(env, 'POST', `/api/devices/${phone.deviceId}/pair-code`, null, phone.deviceToken)).body;
  const again = await call(env, 'POST', '/api/devices/pair', { code: phrase.pairingCode }, mac.senderToken);
  assert.equal(again.body.senderDeviceId, mac.senderDeviceId);
  const inbox = `/api/devices/${phone.deviceId}/transfers`;
  const connected = (await call(env, 'GET', inbox, null, phone.deviceToken)).body.pairedMacs;
  assert.equal(connected.length, 1);
  assert.equal(connected[0].online, true);
  await call(env, 'DELETE', `/api/devices/${phone.deviceId}/pairing`, null, mac.senderToken);
  assert.deepEqual((await call(env, 'GET', inbox, null, phone.deviceToken)).body.pairedMacs, []);
  assert.equal((await call(env, 'DELETE', `/api/devices/${phone.deviceId}/pairing`, null, mac.senderToken)).status, 200);
});

test('inactive legacy pairings are not online, and heartbeat restores active status', async () => {
  const env = fakeEnv();
  const phone = (await call(env, 'POST', '/api/devices/register', { name: 'Pixel' })).body;
  const old = (await call(env, 'POST', '/api/devices/pair', { code: phone.pairingCode })).body;
  const phrase = (await call(env, 'POST', `/api/devices/${phone.deviceId}/pair-code`, null, phone.deviceToken)).body;
  const mac = (await call(env, 'POST', '/api/devices/pair', { code: phrase.pairingCode })).body;
  env.setLastSeen(old.senderDeviceId, Date.now() - 86400000);
  env.setLastSeen(mac.senderDeviceId, Date.now() - 13 * 60000);
  const inbox = `/api/devices/${phone.deviceId}/transfers`;
  assert.equal((await call(env, 'GET', inbox, null, phone.deviceToken)).body.pairedMacs.filter(m => m.online).length, 0);
  await call(env, 'PUT', `/api/devices/${phone.deviceId}/clips`, { items: [] }, mac.senderToken);
  const active = (await call(env, 'GET', inbox, null, phone.deviceToken)).body.pairedMacs.filter(m => m.online);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, mac.senderDeviceId);
  // Removing one pairing leaves the other genuine pairing intact.
  await call(env, 'DELETE', `/api/devices/${phone.deviceId}/pairings/${old.senderDeviceId}`, null, phone.deviceToken);
  assert.deepEqual((await call(env, 'GET', inbox, null, phone.deviceToken)).body.pairedMacs.map(m => m.id), [mac.senderDeviceId]);
});

test('phone-side disconnect is owner-only and revokes pending QR sessions without touching another phone', async () => {
  const env = fakeEnv();
  const phone = (await call(env, 'POST', '/api/devices/register', { name: 'Pixel' })).body;
  const other = (await call(env, 'POST', '/api/devices/register', { name: 'Other' })).body;
  const session = (await call(env, 'POST', '/api/connect/start')).body;
  await call(env, 'POST', '/api/connect/claim', { connectId: session.connectId }, phone.deviceToken);
  env.setPlan(session.senderDeviceId, 'pro');
  const pending = (await call(env, 'POST', '/api/connect/start', null, session.senderToken)).body;
  const path = `/api/devices/${phone.deviceId}/pairings/${session.senderDeviceId}`;
  assert.equal((await call(env, 'DELETE', path, null, other.deviceToken)).status, 401);
  assert.equal((await call(env, 'DELETE', path, null, session.senderToken)).status, 401);
  // A phone cannot revoke an unrelated Mac's pending session by guessing its ID.
  await call(env, 'DELETE', `/api/devices/${other.deviceId}/pairings/${session.senderDeviceId}`, null, other.deviceToken);
  assert.equal((await call(env, 'GET', `/api/connect/${pending.connectId}`, null, session.senderToken)).status, 200);
  assert.equal((await call(env, 'DELETE', path, null, phone.deviceToken)).status, 200);
  assert.equal((await call(env, 'POST', '/api/connect/claim', { connectId: pending.connectId }, phone.deviceToken)).status, 410);
  assert.equal((await call(env, 'GET', '/api/devices/me', null, session.senderToken)).body.pairedPhones, 0);
});

test('an invalid saved sender credential never silently creates a replacement identity', async () => {
  const env = fakeEnv();
  const phone = (await call(env, 'POST', '/api/devices/register', { name: 'Pixel' })).body;
  assert.equal((await call(env, 'POST', '/api/connect/start', null, 'x'.repeat(64))).status, 401);
  assert.equal((await call(env, 'POST', '/api/devices/pair', { code: phone.pairingCode }, 'x'.repeat(64))).status, 401);
});
