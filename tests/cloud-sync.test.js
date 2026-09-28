const test = require('node:test');
const assert = require('node:assert/strict');
const Cloud = require('../cloud-sync.js');

test('sanitizeForCloud keeps text data and excludes image data', () => {
  const source = {
    uid: 4,
    current: 'inbox',
    currentCat: 'all',
    modifiedAt: 123,
    clusters: {
      inbox: {
        color: '#abc',
        notes: [
          { id: 1, type: 'text', content: 'hello', time: 10 },
          { id: 2, type: 'image', content: 'shot', imageId: 99, dataUrl: 'data:image/png;base64,abc', time: 20 }
        ]
      }
    }
  };
  const result = Cloud.sanitizeForCloud(source);
  assert.equal(result.excludedImages, 1);
  assert.deepEqual(result.data.clusters.inbox.notes, [{ id: 1, type: 'text', content: 'hello', time: 10 }]);
  assert.equal(source.clusters.inbox.notes.length, 2);
});

test('mergeCloudWithLocalImages never deletes local-only images', () => {
  const cloud = {
    uid: 8, current: 'inbox', currentCat: 'all', modifiedAt: 200,
    clusters: { inbox: { color: '#111', notes: [{ id: 8, type: 'text', content: 'cloud', time: 200 }] } }
  };
  const local = {
    clusters: { inbox: { color: '#111', notes: [{ id: 2, type: 'image', imageId: 7, time: 100 }] } }
  };
  const merged = Cloud.mergeCloudWithLocalImages(cloud, local);
  assert.deepEqual(merged.clusters.inbox.notes.map((note) => note.type), ['text', 'image']);
  assert.equal(merged.modifiedAt, 200);
});

test('a fresh device pulls existing cloud clips instead of overwriting them', () => {
  const freshLocal = {
    modifiedAt: 999,
    clusters: { inbox: { notes: [] } }
  };
  const remote = {
    modifiedAt: 100,
    clusters: { inbox: { notes: [{ id: 1, type: 'text', content: 'keep me' }] } }
  };
  assert.equal(Cloud.chooseSyncDirection(freshLocal, remote), 'down');
});

test('newest snapshot wins when both devices contain syncable clips', () => {
  const local = {
    modifiedAt: 300,
    clusters: { inbox: { notes: [{ id: 1, type: 'text', content: 'local' }] } }
  };
  const remote = {
    modifiedAt: 200,
    clusters: { inbox: { notes: [{ id: 2, type: 'text', content: 'remote' }] } }
  };
  assert.equal(Cloud.chooseSyncDirection(local, remote), 'up');
  assert.equal(Cloud.chooseSyncDirection({ ...local, modifiedAt: 100 }, remote), 'down');
});

test('RestClient writes and reads the Firestore REST document shape', async () => {
  let writtenBody;
  const fetchMock = async (_url, options = {}) => {
    if (options.method === 'PATCH') {
      writtenBody = JSON.parse(options.body);
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ fields: { payload: writtenBody.fields.payload } }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  const client = new Cloud.RestClient({ projectId: 'demo-cachetray', useEmulators: true, firestoreEmulatorUrl: 'http://127.0.0.1:8080' }, fetchMock);
  const state = { modifiedAt: 10, clusters: { inbox: { notes: [] } } };
  await client.writeState('user-1', 'token', state);
  assert.equal(writtenBody.fields.modifiedAt.integerValue, '10');
  assert.deepEqual(await client.readState('user-1', 'token'), state);
});

test('RestClient preserves the service-worker receiver for native fetch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function () {
    assert.equal(this, globalThis);
    return Promise.resolve(new Response('{}', {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    }));
  };
  try {
    const client = new Cloud.RestClient({
      projectId: 'demo-cachetray',
      useEmulators: true,
      firestoreEmulatorUrl: 'http://127.0.0.1:8080'
    });
    assert.equal(await client.readState('user-1', 'token'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
