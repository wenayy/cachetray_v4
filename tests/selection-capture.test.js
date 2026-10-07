const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const source = fs.readFileSync('content-script.js', 'utf8');
  const start = source.indexOf('  // Save settled, user-made selections');
  const end = source.indexOf('  // Programmatic copy buttons', start);
  const listeners = new Map(), timers = new Map(), saved = [], copied = [];
  let nextTimer = 0;
  const element = { nodeType: 1, isContentEditable: false, closest: () => null,
    getRootNode: () => ({}), querySelectorAll: () => [] };
  const selection = { isCollapsed: false, rangeCount: 1, anchorNode: element, focusNode: element,
    text: 'highlighted text', toString() { return this.text; },
    getRangeAt: () => ({ commonAncestorContainer: element, intersectsNode: () => true }) };
  const context = {
    chrome: { storage: { local: { get: async () => ({ qn_capture_enabled: context.captureEnabled }) } } },
    navigator: { clipboard: { writeText: async text => copied.push(text) } },
    lastFocusedEl: null, showCaptureToast() {}, captureEnabled: true,
    document: { visibilityState: 'visible', addEventListener(name, callback) { listeners.set(name, callback); } },
    window: { getSelection: () => selection, clearTimeout: id => timers.delete(id),
      setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; } },
    normalizeClipboardText: value => value.trim(), sendCopiedText: async (...args) => saved.push(args)
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { element, selection, saved, copied, context,
    event(name, props = {}) { listeners.get(name)({ type: name, isTrusted: true, composedPath: () => [], ...props }); },
    async flush() { const pending = [...timers.values()]; timers.clear(); await Promise.all(pending.map(callback => callback())); } };
}

test('selection captures and copies only settled trusted gestures, including keyboard selection', async () => {
  const h = harness();
  h.event('pointerup', { isTrusted: false }); await h.flush();
  assert.equal(h.saved.length, 0);
  h.event('pointerdown'); h.event('pointerup');
  h.selection.text = 'changed by the page'; await h.flush();
  assert.equal(h.saved.length, 0);
  h.event('pointerup'); h.event('pointerdown'); await h.flush();
  assert.equal(h.saved.length, 0, 'never save intermediate drag selections');
  h.event('pointerup'); await h.flush();
  assert.deepEqual(h.saved[0], ['changed by the page', 'selection']);
  h.selection.text = 'keyboard selection';
  h.event('keyup', { shiftKey: true, key: 'ArrowRight' }); await h.flush();
  assert.deepEqual(h.saved[1], ['keyboard selection', 'selection']);
  assert.deepEqual(h.copied, ['changed by the page', 'keyboard selection']);
});

test('selection ignores editors, password fields, extension UI and selections spanning editors', async () => {
  const h = harness();
  h.element.closest = () => ({ tagName: 'INPUT', type: 'password' });
  h.event('pointerup'); await h.flush();
  h.element.closest = () => null; h.element.isContentEditable = true;
  h.event('pointerup'); await h.flush();
  h.element.isContentEditable = false; h.element.querySelectorAll = () => [{}];
  h.event('pointerup'); await h.flush();
  h.element.querySelectorAll = () => [];
  h.event('pointerup', { composedPath: () => [{ id: 'ct-palette-host' }] }); await h.flush();
  assert.equal(h.saved.length, 0);
  assert.equal(h.copied.length, 0);
});

test('selection cancels on typing, disappearance, hidden pages and capture pause without replacing clipboard', async () => {
  const h = harness();
  h.event('pointerup'); h.event('keydown'); await h.flush();
  h.event('pointerup'); h.selection.isCollapsed = true; await h.flush();
  h.selection.isCollapsed = false; h.event('pointerup'); h.context.document.visibilityState = 'hidden'; await h.flush();
  h.context.document.visibilityState = 'visible'; h.event('pointerup'); h.context.captureEnabled = false; await h.flush();
  assert.equal(h.saved.length, 0);
  assert.equal(h.copied.length, 0);
});

test('copy fallback restores focus and selection; blocked copying still saves the clip', async () => {
  const h = harness();
  h.context.navigator.clipboard.writeText = async () => { throw Error('Clipboard API unavailable'); };
  const range = { cloneRange() { return this; } };
  h.selection.getRangeAt = () => ({ ...range, commonAncestorContainer: h.element });
  let focusRestored = false, removed = false, restoredRange = false, target;
  h.context.document.activeElement = { focus() { focusRestored = true; } };
  h.selection.removeAllRanges = () => {};
  h.selection.addRange = () => { restoredRange = true; };
  h.context.document.body = { appendChild(node) { target = node; } };
  h.context.document.createElement = () => ({ style: {}, setAttribute() {}, select() {}, remove() { removed = true; } });
  h.context.document.execCommand = command => { assert.equal(command, 'copy'); h.copied.push(target.value); return true; };
  h.event('pointerup'); await h.flush();
  assert.deepEqual(h.copied, ['highlighted text']);
  assert(focusRestored && removed && restoredRange);
  h.context.document.execCommand = () => false;
  let warning;
  h.context.showCaptureToast = (...args) => { warning = args; };
  h.event('pointerup'); await h.flush();
  assert.equal(h.saved.length, 2);
  assert.equal(warning[3], 'Auto-copy blocked');
});
