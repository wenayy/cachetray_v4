const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(initial = {}) {
  const stored = structuredClone(initial);
  const sessions = [];
  let starts = 0;
  let account = { plan: 'free', maxPhones: 1, pairedPhones: 0, devices: [] };
  const context = {
    console, Blob, TextEncoder, AbortController,
    setTimeout: () => 1, clearTimeout() {},
    CACHE_TRAY_TRANSFER_API: 'https://worker.example',
    chrome: { storage: { local: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]])); },
      async set(values) { Object.assign(stored, structuredClone(values)); },
      async remove(key) { delete stored[key]; }
    } }, alarms: { create() {}, async clear() {} } },
    async fetch(url, options) {
      if (url.endsWith('/api/connect/start')) {
        starts++;
        // Yield so two concurrent initial requests would create duplicate senders without serialization.
        await new Promise(resolve => setImmediate(resolve));
        const senderId = options.headers.Authorization ? stored.ct_phone_sender_v1.senderDeviceId : `mac-${starts}`;
        const session = { senderDeviceId: senderId, senderToken: 's'.repeat(64), connectId: `qr-${starts}`, expiresAt: Date.now() + 60000 };
        sessions.push(session);
        return Response.json(session);
      }
      if (url.endsWith('/api/devices/me')) {
        if (account instanceof Error) throw account;
        return Response.json(typeof account === 'function' ? account(options.headers.Authorization) : account);
      }
      if (url.endsWith('/clips') && options.method === 'PUT') return Response.json({ synced: true });
      if (url.includes('/api/connect/')) return Response.json({ error: 'Connection not found' }, { status: 404 });
      if (options.method === 'DELETE') return Response.json({ disconnected: true });
      throw new Error(`Unexpected request: ${url}`);
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../transfer-controller.js'), 'utf8'), context);
  return { transfer: context.CacheTrayTransfer, stored, sessions, setAccount(value) { account = value; } };
}

test('simultaneous QR requests reuse one persistent Mac identity, including after disconnect', async () => {
  const h = harness();
  const [one, two] = await Promise.all([h.transfer.startConnect(), h.transfer.startConnect()]);
  assert.equal(one.senderDeviceId, two.senderDeviceId);
  h.stored.ct_phone_pairings_v1 = [{ ...one, receiverDeviceId: 'pixel' }];
  await h.transfer.disconnect('pixel');
  assert.equal(h.stored.ct_phone_pairings_v1.length, 0);
  assert.equal(h.stored.ct_phone_connect_pending_v1, undefined);
  assert.equal((await h.transfer.startConnect()).senderDeviceId, one.senderDeviceId);
});

test('server-side disconnect reconciles local phones; network failure preserves them', async () => {
  const sender = { senderDeviceId: 'mac-1', senderToken: 's'.repeat(64) };
  const h = harness({ ct_phone_sender_v1: sender, ct_phone_pairings_v1: [{ ...sender, receiverDeviceId: 'pixel' }] });
  h.setAccount(new Error('Network unavailable'));
  await assert.rejects(h.transfer.accountStatus(), /Network unavailable/);
  assert.equal(h.stored.ct_phone_pairings_v1.length, 1);
  h.setAccount({ plan: 'free', maxPhones: 1, pairedPhones: 0, devices: [] });
  await h.transfer.accountStatus();
  assert.equal(h.stored.ct_phone_pairings_v1.length, 0);
  assert.deepEqual(h.stored.ct_phone_sender_v1, sender);
});

test('clip sync for a legacy Free pairing cannot overwrite the primary Pro plan', async () => {
  const primary = { senderDeviceId: 'paid-mac', senderToken: 'p'.repeat(64) };
  const h = harness({
    ct_phone_sender_v1: primary,
    ct_phone_pairings_v1: [
      { ...primary, receiverDeviceId: 'new-phone' },
      { senderDeviceId: 'old-mac', senderToken: 'f'.repeat(64), receiverDeviceId: 'old-phone' }
    ],
    quicknotes_v1: { clusters: {} }
  });
  h.setAccount(authorization => ({ plan: authorization === `Bearer ${primary.senderToken}` ? 'pro' : 'free' }));
  await h.transfer.syncClips();
  assert.equal(h.stored.ct_phone_plan_v1.plan, 'pro');
});

test('legacy first pairing credential is reused instead of generating a fresh Mac', async () => {
  const sender = { senderDeviceId: 'existing-mac', senderToken: 's'.repeat(64), receiverDeviceId: 'pixel' };
  const h = harness({ ct_phone_pairings_v1: [sender] });
  assert.equal((await h.transfer.startConnect()).senderDeviceId, 'existing-mac');
  assert.equal(h.stored.ct_phone_sender_v1.senderDeviceId, 'existing-mac');
});

test('a delayed revoked QR response cannot clear a newer pairing session', async () => {
  const h = harness();
  const old = await h.transfer.startConnect();
  const current = await h.transfer.startConnect();
  assert.equal((await h.transfer.connectStatus(old)).expired, true);
  assert.equal(h.stored.ct_phone_connect_pending_v1.connectId, current.connectId);
  assert.equal((await h.transfer.pendingConnect()).connectId, current.connectId);
});
