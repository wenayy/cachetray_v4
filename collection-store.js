/* Shared collection patches. Only the background worker commits collection metadata. */
(function () {
  'use strict';
  const clone = value => structuredClone(value);
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const safeKey = key => !['__proto__', 'prototype', 'constructor'].includes(key);
  const workspaceId = (workspace, name) => workspace.id || `legacy:${name}`;
  const revision = data => Number.isSafeInteger(data?.revision) ? data.revision : 0;
  function normalize(data) {
    const next = clone(data || { clusters: { inbox: { color: '#f87171', notes: [] } }, current: 'inbox', currentCat: 'all', uid: 0 });
    for (const [name, workspace] of Object.entries(next.clusters || {})) {
      workspace.id = workspaceId(workspace, name);
    }
    next.revision = revision(next);
    return next;
  }
  function fields(before = {}, after = {}, excluded = []) {
    const set = {}, unset = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!safeKey(key) || excluded.includes(key)) continue;
      if (!Object.hasOwn(after, key)) unset.push(key);
      else if (!equal(before[key], after[key])) set[key] = clone(after[key]);
    }
    return { set, unset };
  }
  function changed(patch) { return patch.unset.length || Object.keys(patch.set).length; }
  function mapWorkspaces(data) {
    return new Map(Object.entries(data.clusters || {}).map(([name, workspace]) => [workspaceId(workspace, name), { name, workspace }]));
  }
  function diff(before, after) {
    const old = mapWorkspaces(before), next = mapWorkspaces(after), workspaces = [];
    for (const [id] of old) if (!next.has(id)) workspaces.push({ id, remove: true });
    for (const [id, { name, workspace }] of next) {
      const previous = old.get(id);
      const properties = fields(previous?.workspace, workspace, ['id', 'notes']);
      const oldNotes = new Map((previous?.workspace.notes || []).map(note => [String(note.id), note]));
      const newNotes = new Map((workspace.notes || []).map(note => [String(note.id), note]));
      const notes = [];
      for (const [noteId] of oldNotes) if (!newNotes.has(noteId)) notes.push({ id: noteId, remove: true });
      // Reverse additions so applying unshift preserves the client's intended order.
      for (const note of [...(workspace.notes || [])].reverse()) {
        const noteId = String(note.id), prior = oldNotes.get(noteId);
        if (!prior) notes.push({ id: noteId, add: clone(note) });
        else {
          const patch = fields(prior, note, ['id']);
          if (changed(patch)) notes.push({ id: noteId, ...patch });
        }
      }
      if (!previous || previous.name !== name || changed(properties) || notes.length) {
        workspaces.push({ id, name: previous?.name === name ? undefined : name, create: !previous, ...properties, notes });
      }
    }
    const view = {};
    const beforeId = before.clusters?.[before.current] && workspaceId(before.clusters[before.current], before.current);
    const afterId = after.clusters?.[after.current] && workspaceId(after.clusters[after.current], after.current);
    if (beforeId !== afterId) view.currentId = afterId;
    if (before.currentCat !== after.currentCat) view.currentCat = after.currentCat;
    return { workspaces, view };
  }
  function applyFields(target, patch) {
    for (const key of patch.unset || []) if (safeKey(key)) delete target[key];
    for (const [key, value] of Object.entries(patch.set || {})) {
      if (!safeKey(key)) throw new Error('Invalid collection property');
      target[key] = clone(value);
    }
  }
  function apply(data, patch) {
    const next = normalize(data), clusters = next.clusters;
    let activeId = clusters[next.current] && workspaceId(clusters[next.current], next.current);
    for (const change of patch.workspaces || []) {
      let entry = Object.entries(clusters).find(([name, workspace]) => workspaceId(workspace, name) === change.id);
      if (change.remove) { if (entry) delete clusters[entry[0]]; continue; }
      if (!entry) {
        // A stale edit must never resurrect a workspace another window deleted.
        if (!change.create) continue;
        let name = String(change.name || 'inbox');
        if (!safeKey(name)) throw new Error('Invalid workspace name');
        const base = name;
        for (let suffix = 2; Object.hasOwn(clusters, name); suffix++) name = `${base} ${suffix}`;
        clusters[name] = { id: change.id, color: '#f87171', notes: [] };
        entry = [name, clusters[name]];
      }
      let [name, workspace] = entry;
      if (!change.create && change.name && change.name !== name) {
        if (!safeKey(change.name)) throw new Error('Invalid workspace name');
        if (Object.hasOwn(clusters, change.name)) throw new Error('That workspace name is already in use.');
        clusters[change.name] = workspace;
        delete clusters[name];
        name = change.name;
      }
      applyFields(workspace, change);
      for (const edit of change.notes || []) {
        const index = workspace.notes.findIndex(note => String(note.id) === edit.id);
        if (edit.remove) { if (index >= 0) workspace.notes.splice(index, 1); }
        else if (edit.add) { if (index < 0) workspace.notes.unshift(clone(edit.add)); }
        else if (index >= 0) applyFields(workspace.notes[index], edit);
      }
    }
    if (!Object.keys(clusters).length) clusters.inbox = { id: crypto.randomUUID(), color: '#f87171', notes: [] };
    activeId = patch.view?.currentId || activeId;
    next.current = Object.keys(clusters).find(name => workspaceId(clusters[name], name) === activeId) || Object.keys(clusters)[0];
    if (patch.view?.currentCat) next.currentCat = patch.view.currentCat;
    return next;
  }

  class Client {
    constructor({ send, snapshot, update, onError }) {
      Object.assign(this, { send, snapshot, update, onError });
      this.confirmed = normalize();
      this.baseline = clone(this.confirmed);
      this.pending = [];
      this.queue = Promise.resolve();
    }
    initialize(data) {
      this.confirmed = normalize(data);
      this.baseline = clone(this.confirmed);
      this.update(clone(this.confirmed));
    }
    receive(data) {
      const unsaved = diff(this.baseline, this.snapshot());
      if (revision(data) >= revision(this.confirmed)) this.confirmed = normalize(data);
      this.pending = this.pending.filter(operation => operation.revision == null || operation.revision > revision(this.confirmed));
      let merged = clone(this.confirmed);
      for (const operation of this.pending) merged = apply(merged, operation.patch);
      this.baseline = clone(merged);
      this.update(apply(merged, unsaved));
    }
    save() {
      const desired = this.snapshot(), patch = diff(this.baseline, desired);
      this.baseline = clone(desired);
      if (!patch.workspaces.length && !Object.keys(patch.view).length) return Promise.resolve();
      const operation = { patch };
      this.pending.push(operation);
      const result = this.queue.catch(() => {}).then(async () => {
        try {
          const response = await this.send(patch);
          if (!response?.ok || !response.data) throw new Error(response?.error || 'CacheTray did not confirm this save. Please retry.');
          operation.revision = revision(response.data);
          this.receive(response.data);
        } catch (error) {
          this.pending = this.pending.filter(item => item !== operation);
          this.receive(this.confirmed);
          this.onError?.(error);
          throw error;
        }
      });
      this.queue = result;
      // Some navigation handlers intentionally do not await; surface errors without an unhandled rejection.
      result.catch(() => {});
      return result;
    }
  }
  globalThis.CacheTrayCollection = { normalize, diff, apply, Client, workspaceId, revision };
})();
