const POLL_MS = 2500;
const MANUAL_READ_COOLDOWN_MS = 1600;

let lastTextHash = '';
let lastImageHash = '';
let activeReadPromise = null;
let lastManualReadAt = 0;
let pollingInProgress = false;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Robust image hash: length + first 100 + last 100 chars
// Truncated-only hashes cause false duplicates and missed changes
function imageHash(dataUrl) {
  if (typeof dataUrl !== 'string') return '';
  return `${dataUrl.length}:${dataUrl.slice(0, 100)}:${dataUrl.slice(-100)}`;
}

function textHash(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim();
}

function inferTextFromHtml(html, fallbackText) {
  if (!html) return fallbackText || '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchor = doc.querySelector('a[href]');
  if (anchor?.href) {
    return (anchor.textContent || anchor.href || fallbackText || '').trim();
  }
  return fallbackText || '';
}

// ── execCommand paste reader ──────────────────────────────────────────────────
// Only reliable way to read images in MV3 offscreen doc.
// Waits up to 400ms for the paste event even if execCommand returns false,
// because Chrome fires it async in offscreen context.

function execCommandPasteRead() {
  return new Promise((resolve) => {
    const target = document.getElementById('t');
    target.value = '';

    let settled = false;
    let timeoutId = null;

    const cleanup = (payload = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      target.removeEventListener('paste', onPaste, true);
      resolve(payload);
    };

    const onPaste = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const transfer = event.clipboardData;
      if (!transfer) { cleanup(null); return; }

      for (const item of transfer.items || []) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (!file) continue;
          try {
            const dataUrl = await blobToDataUrl(file);
            cleanup({ image: dataUrl, mime: item.type });
          } catch (_) { cleanup(null); }
          return;
        }
      }

      const html = transfer.getData('text/html');
      const text = transfer.getData('text/plain').trim();
      const normalized = inferTextFromHtml(html, text);
      cleanup(normalized ? { text: normalized } : null);
    };

    target.addEventListener('paste', onPaste, true);
    target.focus();

    let pasted = false;
    try { pasted = document.execCommand('paste'); } catch (_) {}
    timeoutId = setTimeout(() => cleanup(null), pasted ? 300 : 400);
  });
}

// ── Full read: modern API first, execCommand fallback ────────────────────────

async function readClipboardPayload() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const types = item.types || [];
      for (const type of types) {
        if (String(type).startsWith('image/')) {
          const blob = await item.getType(type);
          if (blob && blob.size > 0) {
            return { image: await blobToDataUrl(blob), mime: type };
          }
        }
      }
      if (types.includes('text/plain')) {
        const blob = await item.getType('text/plain');
        const text = await blob.text();
        if (text && text.trim()) return { text: text.trim() };
      }
    }
  } catch (_) {}

  return execCommandPasteRead();
}

// ── Concurrency lock ──────────────────────────────────────────────────────────

async function readClipboardPayloadLocked() {
  if (activeReadPromise) return activeReadPromise;
  activeReadPromise = (async () => {
    try { return await readClipboardPayload(); }
    finally { activeReadPromise = null; }
  })();
  return activeReadPromise;
}

// ── On-demand read (content script signalled a copy happened) ────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'READ_CLIPBOARD') return false;
  lastManualReadAt = Date.now();
  readClipboardPayloadLocked()
    .then((result) => sendResponse(result))
    .catch(() => sendResponse(null));
  return true;
});

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollClipboard() {
  if (pollingInProgress) return;
  pollingInProgress = true;
  try {
    if ((await chrome.storage.local.get('qn_capture_enabled')).qn_capture_enabled === false) return;
    if (activeReadPromise) return;
    if (Date.now() - lastManualReadAt < MANUAL_READ_COOLDOWN_MS) return;

    const result = await readClipboardPayloadLocked();
    if (!result) return;

    if (result.image) {
      const hash = imageHash(result.image);
      if (hash === lastImageHash) return;
      const saved = await chrome.runtime.sendMessage({
        type: 'COPIED_IMAGE',
        image: result.image,
        mime: result.mime,
        source: 'poll'
      });
      if (saved?.ok) { lastImageHash = hash; lastTextHash = ''; }

    } else if (result.text) {
      const hash = textHash(result.text);
      if (!hash || hash === lastTextHash) return;
      const saved = await chrome.runtime.sendMessage({
        type: 'COPIED_TEXT',
        text: result.text,
        source: 'poll'
      });
      if (saved?.ok) { lastTextHash = hash; lastImageHash = ''; }
    }
  } catch (_) {}
  finally { pollingInProgress = false; }
}

setInterval(pollClipboard, POLL_MS);
pollClipboard();
