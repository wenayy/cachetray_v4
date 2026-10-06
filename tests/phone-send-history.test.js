const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(ready = true, imageCap) {
  const stored = { ct_phone_pairings_v1: [{ receiverDeviceId: 'pixel', receiverName: 'Pixel', senderToken: 'token' }] };
  const blob = new Blob(['image'], { type: 'image/png' });
  let uploaded;
  const context = { console, Blob, AbortController, AbortSignal, TextEncoder, setTimeout, clearTimeout,
    CT: { imgDbGetRetry: async () => blob }, CACHE_TRAY_TRANSFER_API: 'https://worker.example',
    chrome: { storage: { local: { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]])); }, async set(values) { Object.assign(stored, values); } } } },
    async fetch(url, options) {
      if (url.endsWith('/api/transfers')) return imageCap ? Response.json({ error: 'Phone is full', code: 'IMAGE_LIMIT', limits: { imagesPerPhone: imageCap } }, { status: 403 }) : Response.json({ transferId: 'transfer', uploadUrl: 'https://r2.example/upload' });
      if (url.includes('r2.example')) { uploaded = options.body; return new Response(null, { status: 200 }); }
      if (url.endsWith('/ready')) return Response.json(ready ? { status: 'ready' } : { error: 'Upload mismatch' }, { status: ready ? 200 : 409 });
      throw new Error('Unexpected URL');
    }
  };
  vm.runInNewContext(fs.readFileSync('transfer-controller.js', 'utf8'), context);
  return { stored, blob, context, get uploaded() { return uploaded; } };
}
test('successful send uploads the exact IndexedDB Blob and persists historical sent status', async () => {
  const h = harness();
  await h.context.CacheTrayTransfer.send('image-id', 'test.png', 'pixel');
  assert.equal(h.uploaded, h.blob);
  assert.equal(h.stored.ct_phone_image_sends_v1['image-id'].receiverName, 'Pixel');
  assert.equal(h.stored.ct_phone_image_sends_v1['image-id'].transferId, 'transfer');
});
test('a failed ready verification never marks the image as sent', async () => {
  const h = harness(false);
  await assert.rejects(h.context.CacheTrayTransfer.send('image-id', 'test.png', 'pixel'), /Upload mismatch/);
  assert.equal(h.stored.ct_phone_image_sends_v1, undefined);
});
test('image-limit errors preserve the server code and allowance without uploading', async () => {
  const h = harness(true, 5);
  await assert.rejects(h.context.CacheTrayTransfer.send('sixth-image', 'test.png', 'pixel'), error => error.code === 'IMAGE_LIMIT' && error.limits.imagesPerPhone === 5);
  assert.equal(h.uploaded, undefined);
  assert.equal(h.stored.ct_phone_image_sends_v1, undefined);
});
