/**
 * CacheTray – Shared utilities
 * Loaded by: background.js (importScripts), popup/sidebar (script tag)
 */

/* exported CT */
const CT = (() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  const STORAGE_KEY = 'quicknotes_v1';
  const CAPTURE_KEY = 'qn_capture_enabled';
  const IMAGE_DB_NAME = 'cachetray_img';
  const IMAGE_STORE = 'blobs';
  const COLORS = ['#f87171', '#fbbf24', '#34d399', '#a78bfa', '#60a5fa', '#f472b6'];
  const CAT_LIMIT = 10000;
  const EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;

  // ── Cached IndexedDB connection ────────────────────────────────────────────
  let _db = null;
  let _dbOpening = null;

  function _resetDb() {
    _db = null;
    _dbOpening = null;
  }

  function openImageDb() {
    if (_db) {
      try {
        // Verify the connection is still alive by checking objectStoreNames
        _db.objectStoreNames;
        return Promise.resolve(_db);
      } catch (_) {
        _resetDb();
      }
    }
    if (_dbOpening) return _dbOpening;

    _dbOpening = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(IMAGE_DB_NAME, 1);
      } catch (e) {
        _resetDb();
        reject(e);
        return;
      }
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IMAGE_STORE)) {
          db.createObjectStore(IMAGE_STORE, { autoIncrement: true });
        }
      };
      req.onsuccess = (e) => {
        _db = e.target.result;
        _db.onclose = _resetDb;
        _db.onversionchange = () => { try { _db.close(); } catch (_) {} _resetDb(); };
        _dbOpening = null;
        resolve(_db);
      };
      req.onerror = () => {
        _resetDb();
        reject(req.error);
      };
    });
    return _dbOpening;
  }

  async function imgDbStore(blob) {
    if (!(blob instanceof Blob) || blob.size === 0) throw new Error('Cannot store an empty image');
    const db = await openImageDb();
    return new Promise((resolve, reject) => {
      // Wait for the durable transaction, not the individual add request. A request
      // can succeed and then have its transaction abort, leaving a dangling imageId.
      const tx = db.transaction(IMAGE_STORE, 'readwrite', { durability: 'strict' });
      const req = tx.objectStore(IMAGE_STORE).add(blob);
      let id;
      req.onsuccess = () => { id = req.result; };
      tx.oncomplete = () => resolve(id);
      tx.onabort = () => reject(tx.error || req.error || new Error('Image save was aborted'));
      tx.onerror = () => reject(tx.error || req.error || new Error('Image save failed'));
    });
  }

  async function imgDbGet(id) {
    const db = await openImageDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGE_STORE, 'readonly');
      const req = tx.objectStore(IMAGE_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function imgDbGetRetry(id, retries) {
    if (retries === undefined) retries = 2;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await imgDbGet(id);
        if (result) return result;
        // null result on first tries — reset connection and retry
        if (attempt < retries) _resetDb();
      } catch (_) {
        if (attempt < retries) _resetDb();
      }
    }
    return null;
  }

  async function imgDbDelete(id) {
    const db = await openImageDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGE_STORE, 'readwrite');
      tx.objectStore(IMAGE_STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function imgDbDeleteIfUnreferenced(id) {
    if (id == null) return false;
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const stillUsed = Object.values(stored[STORAGE_KEY]?.clusters || {}).some(cluster =>
      (cluster.notes || []).some(note => note.imageId != null && String(note.imageId) === String(id)));
    if (stillUsed) return false;
    await imgDbDelete(id);
    return true;
  }

  // ── Data normalization ─────────────────────────────────────────────────────
  function normalizeStoredData(data) {
    if (!data?.clusters) return data;
    Object.values(data.clusters).forEach((cluster) => {
      cluster.notes = (cluster.notes || []).map((n) => {
        if (n.type === 'note') n = { ...n, type: 'text' };
        if (n.pinned && !n.favorited) n = { ...n, favorited: true };
        if ('pinned' in n) { const { pinned, ...rest } = n; n = rest; }
        return n;
      });
    });
    if (data.currentCat === 'note') data.currentCat = 'text';
    return data;
  }

  // ── Type detection ─────────────────────────────────────────────────────────
  const CODE_PATTERNS = [
    /^```/,
    /^\$ /,
    /^(npm|npx|yarn|pnpm|git|pip|python3?|node|curl|cd)\b/,
    /^(const|let|var)\s+[A-Za-z_$][\w$]*\s*=/,
    /^function\s+[A-Za-z_$][\w$]*\s*\(/,
    /^(async\s+function|async\s+\()/,
    /^class\s+[A-Za-z_$][\w$]*/,
    /\bimport\s+[\w{*].+\s+from\s+['"]/,
    /\bexport\s+(default|const|function|class|\{)/,
    /\breturn\s+[({<"'`][\s\S]*[)}>'"`;]$/,
    /(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*[{(["'`\w]/,
    /^<(div|span|p|a|ul|li|input|button|form|img|svg|html|head|body|script|style|section|header|footer|nav|main|article)\b/i,
    /^<\/[a-z]+>$/i,
    /^#(include|define|ifndef|pragma)\b/,
    /^(public|private|protected)\s+(static\s+)?(void|int|String|boolean|class)\b/,
    /^def\s+[a-z_]\w*\s*\(/,
    /^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\s+/i,
  ];

  function looksLikeUrl(text) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return true;
    if (/\s/.test(trimmed)) return false;
    if (!/^(www\.|[a-z0-9-]+\.[a-z]{2,})(\/|$)/i.test(trimmed)) return false;
    try { return Boolean(new URL(`https://${trimmed}`).hostname); }
    catch (_) { return false; }
  }

  function toLinkUrl(text) {
    const trimmed = text.trim();
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  function looksLikeCode(text) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (CODE_PATTERNS.some((p) => p.test(trimmed))) return true;
    if (!trimmed.includes('\n')) return false;
    const lines = trimmed.split('\n').map((l) => l.trimEnd());
    const total = lines.filter((l) => l.trim()).length;
    if (total < 2) return false;
    const indented = lines.filter((l) => /^\s{2,}\S/.test(l)).length;
    const keywords = lines.filter((l) =>
      /^(if|for|while|return|else|try|catch|switch|case|break|continue|throw)\b/.test(l.trim())
    ).length;
    const braces = lines.filter((l) => /^[\s]*[{}][\s;]*$/.test(l)).length;
    return (indented >= 3 && braces >= 1) || keywords >= 2 || /```/.test(trimmed);
  }

  function detectType(text) {
    if (!text) return 'text';
    if (looksLikeUrl(text)) return 'link';
    if (looksLikeCode(text)) return 'code';
    return 'text';
  }

  function guessLang(text) {
    if (/^npm |^npx |^git |^cd |^\$ /.test(text)) return 'sh';
    if (/import|export|const|=>/.test(text)) return 'js';
    if (/def |print\(/.test(text)) return 'py';
    return 'js';
  }

  // ── Comparison keys ────────────────────────────────────────────────────────
  function normalizeTextKey(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim();
  }

  function imageComparisonKey(src) {
    if (!src) return '';
    return `img:${src.length}:${src.slice(0, 120)}:${src.slice(-120)}`;
  }

  function noteComparisonKey(note) {
    if (!note || typeof note !== 'object') return '';
    if (note.type === 'image') {
      return note.imageHash || imageComparisonKey(note.dataUrl || note.imageUrl || '');
    }
    if (note.type === 'link') return note.url || normalizeTextKey(note.content || '');
    if (note.type === 'code') return normalizeTextKey(note.full || note.content || '');
    return normalizeTextKey(note.content || '');
  }

  function findDuplicateNote(clusters, note) {
    const targetKey = noteComparisonKey(note);
    if (!targetKey) return null;
    for (const [clusterName, cluster] of Object.entries(clusters)) {
      const existing = (cluster.notes || []).find(
        (n) => n.type === note.type && noteComparisonKey(n) === targetKey
      );
      if (existing) return { note: existing, clusterName };
    }
    return null;
  }

  // ── Cluster helpers ────────────────────────────────────────────────────────
  function ensureCluster(clusters, name) {
    if (!clusters[name]) {
      const color = COLORS[Object.keys(clusters).length % COLORS.length];
      clusters[name] = { color, notes: [] };
    }
  }

  function findOrCreateOverflow(clusters, baseName, type) {
    let idx = 2;
    while (true) {
      const candidate = `${baseName} ${idx}`;
      if (clusters[candidate]) {
        if (clusters[candidate].notes.filter((n) => n.type === type).length < CAT_LIMIT) return candidate;
        idx++;
        continue;
      }
      clusters[candidate] = { color: clusters[baseName]?.color || COLORS[0], notes: [] };
      return candidate;
    }
  }

  // ── Image injection (canonical function for executeScript) ─────────────────
  // This is the single source of truth for pasting images into AI chat editors.
  // Passed as `func` to chrome.scripting.executeScript({ world: 'MAIN' }).
  const injectImagesFunc = async function (imageList) {
    function findEditable(root) {
      if (!root) root = document;
      const all = [...root.querySelectorAll('[contenteditable="true"]:not([aria-hidden="true"]), textarea')];
      const visible = all.filter(function (el) { var r = el.getBoundingClientRect(); return r.width > 10 && r.height > 10; });
      if (visible.length) return visible[visible.length - 1];
      if (all.length) return all[0];
      for (var i = 0; i < root.querySelectorAll('*').length; i++) {
        var host = root.querySelectorAll('*')[i];
        if (host.shadowRoot) { var f = findEditable(host.shadowRoot); if (f) return f; }
      }
      return null;
    }
    var ts = Date.now();
    var files = imageList.map(function (item, idx) {
      var parts = item.dataUrl.split(',');
      var type = item.mime || (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
      var bin = atob(parts[1]);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], 'image-' + (idx + 1) + '-' + ts + '.' + (type.includes('png') ? 'png' : 'jpg'), { type: type });
    });
    // Twitter/X: drag-and-drop
    if (/^(twitter\.com|x\.com)$/.test(location.hostname)) {
      var composer = document.querySelector('[data-testid="tweetTextarea_0"]') || findEditable();
      if (!composer) return;
      var dt = new DataTransfer();
      files.forEach(function (f) { dt.items.add(f); });
      composer.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      composer.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      composer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return;
    }
    // All other editors: paste with focus treatment
    var el = (document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement)
      ? document.activeElement : findEditable();
    if (!el) return;
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, cancelable: false }));
    el.dispatchEvent(new FocusEvent('focus', { bubbles: false, cancelable: false }));
    el.focus();
    var origProto = Document.prototype.hasFocus;
    Document.prototype.hasFocus = function () { return true; };
    Object.defineProperty(document, 'hasFocus', { value: function () { return true; }, configurable: true, writable: true });
    await new Promise(function (r) { setTimeout(r, 80); });
    try {
      for (var fi = 0; fi < files.length; fi++) {
        var pdt = new DataTransfer();
        pdt.items.add(files[fi]);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: pdt, bubbles: true, cancelable: true }));
        await new Promise(function (r) { setTimeout(r, 150); });
      }
    } finally {
      Document.prototype.hasFocus = origProto;
      try { delete document.hasFocus; } catch (_) {}
    }
  };

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    STORAGE_KEY, CAPTURE_KEY, IMAGE_DB_NAME, IMAGE_STORE,
    COLORS, CAT_LIMIT, EXPIRY_MS,
    openImageDb, imgDbStore, imgDbGet, imgDbGetRetry, imgDbDelete, imgDbDeleteIfUnreferenced,
    normalizeStoredData,
    looksLikeUrl, toLinkUrl, looksLikeCode, detectType, guessLang,
    normalizeTextKey, imageComparisonKey, noteComparisonKey,
    findDuplicateNote, ensureCluster, findOrCreateOverflow,
    injectImagesFunc,
  };
})();
