const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const context = { structuredClone, crypto: webcrypto };
vm.runInNewContext(fs.readFileSync('collection-store.js', 'utf8'), context);
const Model = context.CacheTrayCollection;
const initial = () => Model.normalize({ uid: 2, current: 'inbox', currentCat: 'all', revision: 0,
  clusters: { inbox: { color: 'red', notes: [
    { id: 1, content: 'original', type: 'text', time: 1 },
    { id: 2, content: 'image', type: 'image', imageId: 17, time: 2 }
  ] } } });

test('stale popup patches retain concurrent background captures and unrelated note fields', () => {
  const base = initial(), popup = structuredClone(base), server = structuredClone(base);
  popup.clusters.inbox.notes[0].favorited = true;
  server.clusters.inbox.notes.unshift({ id: 'unique-image', type: 'image', imageId: 123, content: 'capture', time: 3 });
  server.clusters.inbox.notes.find(n => n.id === 1).content = 'renamed elsewhere';
  const next = Model.apply(server, Model.diff(base, popup));
  assert.equal(next.clusters.inbox.notes.length, 3);
  const edited = next.clusters.inbox.notes.find(n => n.id === 1);
  assert.equal(edited.content, 'renamed elsewhere');
  assert.equal(edited.favorited, true);
});

test('workspace rename keeps concurrent captures; stale edits follow stable workspace ID', () => {
  const base = initial(), rename = structuredClone(base);
  rename.clusters.renamed = rename.clusters.inbox;
  delete rename.clusters.inbox;
  rename.current = 'renamed';
  const server = structuredClone(base);
  server.clusters.inbox.notes.unshift({ id: 'capture', type: 'text', content: 'new' });
  const renamed = Model.apply(server, Model.diff(base, rename));
  assert.equal(renamed.current, 'renamed');
  assert.equal(renamed.clusters.renamed.notes.length, 3);
  const oldPopup = structuredClone(base);
  oldPopup.clusters.inbox.notes[0].done = true;
  const next = Model.apply(renamed, Model.diff(base, oldPopup));
  assert.equal(next.clusters.renamed.notes.find(n => n.id === 1).done, true);
  assert(!next.clusters.inbox);
});

test('stale delete removes only selected items, not newly captured items; edits cannot resurrect deleted notes', () => {
  const base = initial(), deleting = structuredClone(base), server = structuredClone(base);
  deleting.clusters.inbox.notes = [];
  server.clusters.inbox.notes.unshift({ id: 'new', content: 'retain', type: 'text' });
  const next = Model.apply(server, Model.diff(base, deleting));
  assert.equal(next.clusters.inbox.notes.length, 1);
  assert.equal(next.clusters.inbox.notes[0].id, 'new');
  const editing = structuredClone(base);
  editing.clusters.inbox.notes[0].content = 'stale edit';
  assert.equal(Model.apply(next, Model.diff(base, editing)).clusters.inbox.notes.length, 1);
});

test('clients rebase pending and unsaved edits over notifications and out-of-order responses', async () => {
  let ui = initial(), complete;
  const client = new Model.Client({ snapshot: () => structuredClone(ui), update: data => { ui = data; },
    send: () => new Promise(resolve => { complete = resolve; }) });
  client.initialize(ui);
  ui.clusters.inbox.notes[0].favorited = true;
  const saving = client.save();
  await Promise.resolve();
  await Promise.resolve();
  ui.clusters.inbox.notes[1].content = 'unsaved image rename';
  const remote = initial();
  remote.revision = 2;
  remote.clusters.inbox.notes.unshift({ id: 'remote', type: 'text', content: 'remote' });
  client.receive(remote);
  assert.equal(ui.clusters.inbox.notes.length, 3);
  assert.equal(ui.clusters.inbox.notes.find(n => n.id === 1).favorited, true);
  assert.equal(ui.clusters.inbox.notes.find(n => n.id === 2).content, 'unsaved image rename');
  const committed = initial();
  committed.revision = 1;
  committed.clusters.inbox.notes[0].favorited = true;
  complete({ ok: true, data: committed });
  await saving;
  assert.equal(ui.clusters.inbox.notes.length, 3);
  assert.equal(ui.clusters.inbox.notes.find(n => n.id === 2).content, 'unsaved image rename');
  assert.equal(client.pending.length, 0);
});

test('failed metadata commit is visibly rejected and optimistic data rolls back', async () => {
  let ui = initial(), reported;
  const client = new Model.Client({ snapshot: () => structuredClone(ui), update: data => { ui = data; },
    send: async () => ({ ok: false, error: 'Disk full' }), onError: error => { reported = error.message; } });
  client.initialize(ui);
  ui.clusters.inbox.notes[0].content = 'not persisted';
  await assert.rejects(client.save(), /Disk full/);
  assert.equal(reported, 'Disk full');
  assert.equal(ui.clusters.inbox.notes[0].content, 'original');
});

test('new workspace collisions preserve both workspaces; prototype-like names are rejected', () => {
  const base = initial(), add = structuredClone(base), server = structuredClone(base);
  add.clusters.work = { id: 'popup-work', notes: [], color: 'red' };
  server.clusters.work = { id: 'sidebar-work', notes: [{ id: 'keep', content: 'keep' }] };
  const result = Model.apply(server, Model.diff(base, add));
  assert.equal(result.clusters.work.notes[0].content, 'keep');
  assert.equal(result.clusters['work 2'].id, 'popup-work');
  assert.throws(() => Model.apply(base, { workspaces: [{ create: true, id: 'bad', name: '__proto__', notes: [] }] }), /Invalid workspace/);
});

test('real background queues popup patches behind an in-flight capture and rejects webpage mutations', async () => {
  const source = fs.readFileSync('background.js', 'utf8');
  let handler, stored = initial(), release;
  const queueContext = { console: { error() {} }, Date, CacheTrayCollection: Model, OFFSCREEN_DOCUMENT_PATH: 'offscreen.html',
    chrome: { runtime: { id: 'test-extension', getURL: page => `chrome-extension://test-extension/${page}`,
      onMessage: { addListener(callback) { handler = callback; } } } },
    loadData: async () => structuredClone(stored), saveData: async next => { next.revision = stored.revision + 1; stored = structuredClone(next); } };
  let start = source.indexOf('function enqueueSave('), end = source.indexOf('async function addStoredNote(', start);
  vm.runInNewContext('let saveQueue = Promise.resolve();\n' + source.slice(start, end), queueContext);
  start = source.indexOf('chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {');
  end = source.indexOf('\n});', start) + '\n});'.length;
  vm.runInNewContext(source.slice(start, end), queueContext);
  const captured = queueContext.enqueueSave(async () => {
    const snapshot = structuredClone(stored);
    await new Promise(resolve => { release = resolve; });
    snapshot.clusters.inbox.notes.unshift({ id: 'capture', type: 'image', imageId: 99 });
    await queueContext.saveData(snapshot);
  });
  await Promise.resolve();
  const edited = initial();
  edited.clusters.inbox.notes[0].content = 'popup edit';
  const patch = Model.diff(initial(), edited);
  const committed = new Promise(resolve => handler({ type: 'COLLECTION_PATCH', patch },
    { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' }, resolve));
  release();
  await captured;
  assert.equal((await committed).ok, true);
  assert.equal(stored.clusters.inbox.notes.length, 3);
  assert.equal(stored.clusters.inbox.notes.find(n => n.id === 1).content, 'popup edit');
  const denied = await new Promise(resolve => handler({ type: 'COLLECTION_PATCH', patch },
    { id: 'test-extension', url: 'https://page.example/', tab: { id: 1 } }, resolve));
  assert.equal(denied.ok, false);
});
