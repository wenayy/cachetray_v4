const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('page message bridge is absent; copy and cut capture reject synthetic events', async () => {
  const source = fs.readFileSync('content-script.js', 'utf8');
  assert(!source.includes("window.addEventListener('message'"));
  assert(!source.includes('injected.js'));
  const events = new Map(), captures = [];
  const start = source.indexOf("  document.addEventListener(\n    'copy',");
  const end = source.indexOf("  document.addEventListener('keydown'", start);
  vm.runInNewContext(source.slice(start, end), {
    document: { addEventListener: (name, callback) => events.set(name, callback) },
    window: { clearTimeout() {} }, interactionReadTimer: 0,
    getCopiedText: () => 'selected text', sendCopiedText: async (...args) => captures.push(args), requestClipboardImageCheck() {}
  });
  events.get('copy')({ isTrusted: false });
  events.get('cut')({ isTrusted: false });
  assert.equal(captures.length, 0);
  events.get('copy')({ isTrusted: true });
  await Promise.resolve();
  assert.equal(captures.length, 1);
});

test('background only accepts image payloads from its offscreen document and validates size/type', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  const start = source.indexOf('chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {');
  const end = source.indexOf('\n});', start) + '\n});'.length;
  let handler;
  const chrome = { runtime: { id: 'extension', getURL: page => `chrome-extension://extension/${page}`,
    onMessage: { addListener(callback) { handler = callback; } } } };
  vm.runInNewContext(source.slice(start, end), { chrome, OFFSCREEN_DOCUMENT_PATH: 'offscreen.html' });
  let response;
  const respond = result => { response = result; };
  const image = { type: 'COPIED_IMAGE', image: 'data:image/png;base64,AAAA' };
  assert.equal(handler(image, { id: 'extension', url: 'https://page.example/', tab: { id: 1 } }, respond), false);
  assert.match(response.error, /Untrusted/);
  const offscreen = { id: 'extension', url: 'chrome-extension://extension/offscreen.html' };
  assert.equal(handler({ ...image, image: 'data:image/svg+xml;base64,AAAA' }, offscreen, respond), false);
  assert.match(response.error, /Unsupported/);
  assert.equal(handler({ type: 'COPIED_TEXT', text: 'a'.repeat(1_000_001) }, offscreen, respond), false);
  assert.match(response.error, /oversized/);
});

test('clipboard polling records hashes only after an acknowledged save and retries failures', async () => {
  const source = fs.readFileSync('offscreen.js', 'utf8');
  const start = source.indexOf('async function pollClipboard()');
  const end = source.indexOf('\nsetInterval(', start);
  let sends = 0;
  const context = { Date, pollingInProgress: false, lastManualReadAt: 0, MANUAL_READ_COOLDOWN_MS: 1600, activeReadPromise: null,
    lastImageHash: '', lastTextHash: '', textHash: text => text, readClipboardPayloadLocked: async () => ({ text: 'copied' }),
    chrome: { storage: { local: { get: async () => ({}) } }, runtime: { sendMessage: async () => ({ ok: ++sends > 1 }) } } };
  vm.runInNewContext(source.slice(start, end), context);
  await context.pollClipboard();
  assert.equal(context.lastTextHash, '');
  await context.pollClipboard();
  assert.equal(context.lastTextHash, 'copied');
  await context.pollClipboard();
  assert.equal(sends, 2);
});
