export const emptyState = () => ({
  uid: 0,
  current: 'inbox',
  currentCat: 'all',
  modifiedAt: 0,
  clusters: { inbox: { color: '#f87171', notes: [] } }
});

export function addTextClip(state, content, now = Date.now()) {
  const value = content.trim();
  if (!value) return state;
  const inbox = state.clusters?.inbox || { color: '#f87171', notes: [] };
  const nextId = Math.max(Number(state.uid) || 0, ...inbox.notes.map((note) => Number(note.id) || 0)) + 1;
  const type = /^https?:\/\//i.test(value) ? 'link' : 'text';
  return {
    ...state,
    uid: nextId,
    current: 'inbox',
    clusters: {
      ...state.clusters,
      inbox: {
        ...inbox,
        notes: [{ id: nextId, type, content: value, time: now }, ...inbox.notes]
      }
    }
  };
}

export function deleteClip(state, clipId) {
  const inbox = state.clusters?.inbox || { color: '#f87171', notes: [] };
  return {
    ...state,
    clusters: {
      ...state.clusters,
      inbox: { ...inbox, notes: inbox.notes.filter((note) => note.id !== clipId) }
    }
  };
}
