const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('the real background message handler returns image-limit errors instead of crashing in catch', async () => {
  const source = fs.readFileSync('background.js', 'utf8');
  let handler;
  const failure = Object.assign(new Error('Your phone can hold 5 images at once'), {
    code: 'IMAGE_LIMIT', limits: { imagesPerPhone: 5 }
  });
  const start = source.indexOf('chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {');
  const end = source.indexOf('\n});', start) + '\n});'.length;
  vm.runInNewContext(source.slice(start, end), {
    console: { error() {} },
    chrome: { runtime: { onMessage: { addListener(callback) { handler = callback; } } } },
    CacheTrayTransfer: { send: async () => { throw failure; } }
  });
  for (const sender of [{}, { tab: { id: 123 } }]) {
    const response = await new Promise(resolve => {
      assert.equal(handler({ type: 'TRANSFER_SEND_IMAGE', imageId: 'sixth-image', receiverDeviceId: 'phone' }, sender, resolve), true);
    });
    assert.equal(response.ok, false);
    assert.equal(response.code, 'IMAGE_LIMIT');
    assert.equal(response.limits.imagesPerPhone, 5);
    assert.match(response.error, /5 images/);
  }
});
