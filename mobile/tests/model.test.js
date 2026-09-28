import test from 'node:test';
import assert from 'node:assert/strict';
import { addTextClip, deleteClip, emptyState } from '../src/model.js';

test('adds text and links using the extension-compatible state shape', () => {
  const textState = addTextClip(emptyState(), 'hello', 100);
  const linkState = addTextClip(textState, 'https://cachetray.app', 200);

  assert.equal(linkState.uid, 2);
  assert.deepEqual(linkState.clusters.inbox.notes.map(({ type, content, time }) => ({ type, content, time })), [
    { type: 'link', content: 'https://cachetray.app', time: 200 },
    { type: 'text', content: 'hello', time: 100 }
  ]);
});

test('deletes a clip without mutating the input state', () => {
  const before = addTextClip(emptyState(), 'temporary', 100);
  const after = deleteClip(before, 1);

  assert.equal(before.clusters.inbox.notes.length, 1);
  assert.equal(after.clusters.inbox.notes.length, 0);
});
