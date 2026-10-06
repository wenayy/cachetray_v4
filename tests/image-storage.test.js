const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function imageDbHarness() {
  let transaction;
  let storedBlob;
  let requestSucceeded;
  const requestDone = new Promise(resolve => { requestSucceeded = resolve; });
  const database = {
    objectStoreNames: { contains: () => true },
    transaction(_store, mode, options) {
      assert.equal(mode, 'readwrite');
      assert.equal(options.durability, 'strict');
      const request = { result: 17 };
      transaction = {
        error: null,
        objectStore() { return { add(blob) {
          storedBlob = blob;
          queueMicrotask(() => { request.onsuccess?.(); requestSucceeded(); });
          return request;
        } }; }
      };
      return transaction;
    }
  };
  const indexedDB = { open() {
    const request = { result: database };
    queueMicrotask(() => request.onsuccess?.({ target: { result: database } }));
    return request;
  } };
  const context = { Blob, indexedDB, console };
  vm.runInNewContext(fs.readFileSync(require.resolve('../shared.js'), 'utf8') + '\nglobalThis.CT = CT;', context);
  return { CT: context.CT, requestDone, get transaction() { return transaction; }, get storedBlob() { return storedBlob; } };
}

test('image store only resolves after the strict IndexedDB transaction commits', async () => {
  const harness = imageDbHarness();
  const blob = new Blob(['image bytes'], { type: 'image/png' });
  const pending = harness.CT.imgDbStore(blob);
  await harness.requestDone;
  assert.equal(harness.storedBlob, blob);
  let settled = false;
  pending.finally(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  harness.transaction.oncomplete();
  assert.equal(await pending, 17);
});

test('aborted image transaction rejects instead of returning a dangling image ID', async () => {
  const harness = imageDbHarness();
  const pending = harness.CT.imgDbStore(new Blob(['image bytes'], { type: 'image/png' }));
  await harness.requestDone;
  harness.transaction.error = new Error('Disk full');
  harness.transaction.onabort();
  await assert.rejects(pending, /Disk full/);
});
