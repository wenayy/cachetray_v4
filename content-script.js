(function () {
  if (window.__quicknotesContentLoaded) return;
  window.__quicknotesContentLoaded = true;

  const INTERACTION_READ_DELAY_MS = 180;
  const STORAGE_KEY = 'quicknotes_v1';
  let interactionReadTimer = 0;
  let readInProgress = false;
  let pendingImageCheckTimer = 0;
  let pendingImageCheckToken = 0;
  let lastStoredTextKey = '';
  let lastStoredImageHash = '';
  let hasLoadedLastStored = false;
  let lastFocusedEl = null;

  function onFocusIn(e) {
    const el = e.target;
    if (el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      lastFocusedEl = el;
    }
  }
  document.addEventListener('focusin', onFocusIn, true);
  // Also capture focus events that originate inside shadow roots
  document.addEventListener('focusin', (e) => {
    if (e.composedPath) {
      const inner = e.composedPath().find(
        (n) => n instanceof Element && (n.isContentEditable || n.tagName === 'INPUT' || n.tagName === 'TEXTAREA')
      );
      if (inner) lastFocusedEl = inner;
    }
  }, true);

  function normalizeClipboardText(value) {
    if (typeof value !== 'string') return '';
    return value.trim();
  }

  function toComparisonKey(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim();
  }

  function imageQuickHash(dataUrl) {
    if (typeof dataUrl !== 'string') return '';
    return `img:${dataUrl.length}:${dataUrl.slice(0, 120)}:${dataUrl.slice(-120)}`;
  }

  function syncLastStoredFromQuicknotesValue(value) {
    const data = value && typeof value === 'object' ? value : null;
    if (!data?.clusters) {
      lastStoredTextKey = '';
      lastStoredImageHash = '';
      return;
    }

    let latest = null;
    Object.values(data.clusters).forEach((cluster) => {
      (cluster.notes || []).forEach((note) => {
        if (!latest || (note.time || 0) > (latest.time || 0)) latest = note;
      });
    });

    if (!latest) {
      lastStoredTextKey = '';
      lastStoredImageHash = '';
      return;
    }

    if (latest.type === 'image') {
      lastStoredImageHash = latest.imageHash || imageQuickHash(latest.dataUrl || latest.imageUrl || '');
      lastStoredTextKey = '';
      return;
    }

    const comparisonValue =
      latest.type === 'code' ? (latest.full || latest.content || '') :
      latest.type === 'link' ? (latest.url || latest.content || '') :
      (latest.content || '');

    lastStoredTextKey = toComparisonKey(comparisonValue);
    lastStoredImageHash = '';
  }

  async function loadLastStored() {
    if (hasLoadedLastStored) return;
    hasLoadedLastStored = true;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      syncLastStoredFromQuicknotesValue(result[STORAGE_KEY]);
    } catch (error) {
      // background still does duplicate checks
    }
  }

  function showCaptureToast(itemType, preview, failed = false, statusLabel = '') {
    const TYPE_META = {
      link:  { label: 'Link',    color: '#60a5fa', icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' },
      image: { label: 'Image',   color: '#fbbf24', icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' },
      code:  { label: 'Code',    color: '#a78bfa', icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>' },
      task:  { label: 'Task',    color: '#f87171', icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' },
      text:  { label: 'Text',    color: '#94a3b8', icon: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>' },
    };
    const meta = failed ? { ...TYPE_META.image, color: '#f87171' } : (TYPE_META[itemType] || TYPE_META.text);

    let wrapper = document.getElementById('__qn_toast_wrap__');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = '__qn_toast_wrap__';
      Object.assign(wrapper.style, {
        position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647',
        pointerEvents: 'none', display: 'flex', flexDirection: 'column',
        alignItems: 'flex-end', gap: '8px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
      });
      (document.body || document.documentElement).appendChild(wrapper);
    }

    const toast = document.createElement('div');
    Object.assign(toast.style, {
      background: 'rgba(12,12,12,0.97)',
      borderRadius: '12px',
      border: '0.5px solid rgba(255,255,255,0.10)',
      borderLeft: `3px solid ${meta.color}`,
      boxShadow: '0 8px 32px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.3)',
      width: '252px',
      overflow: 'hidden',
      pointerEvents: 'none',
    });

    // Header row: logo + "CacheTray" + "captured" badge
    const head = document.createElement('div');
    Object.assign(head.style, {
      display: 'flex', alignItems: 'center', gap: '6px',
      padding: '9px 12px 7px',
      borderBottom: '0.5px solid rgba(255,255,255,0.07)',
    });

    const logo = document.createElement('div');
    logo.innerHTML = '<svg width="12" height="12" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg"><rect width="128" height="128" rx="24" fill="#111"/><polygon points="66,12 88,12 62,66 80,66 46,116 62,72 46,72" fill="#c8f060"/></svg>';

    const brand = document.createElement('span');
    brand.textContent = 'CacheTray';
    Object.assign(brand.style, { color: '#c8f060', fontSize: '10px', fontWeight: '700', letterSpacing: '0.3px', flex: '1' });

    const badge = document.createElement('span');
    badge.textContent = statusLabel || (failed ? 'not saved' : 'captured');
    Object.assign(badge.style, {
      fontSize: '9px', color: '#555', letterSpacing: '0.5px',
      textTransform: 'uppercase', fontWeight: '600'
    });

    head.appendChild(logo); head.appendChild(brand); head.appendChild(badge);

    // Body row: type icon + label + preview
    const body = document.createElement('div');
    Object.assign(body.style, { padding: '8px 12px 10px', display: 'flex', flexDirection: 'column', gap: '3px' });

    const typeRow = document.createElement('div');
    Object.assign(typeRow.style, { display: 'flex', alignItems: 'center', gap: '6px' });

    const iconWrap = document.createElement('span');
    iconWrap.innerHTML = meta.icon;
    Object.assign(iconWrap.style, { color: meta.color, display: 'flex', flexShrink: '0' });

    const typeLabel = document.createElement('span');
    typeLabel.textContent = statusLabel || (failed ? 'Image was not saved' : `${meta.label} saved`);
    Object.assign(typeLabel.style, { color: '#e8e5e0', fontSize: '12px', fontWeight: '600' });

    typeRow.appendChild(iconWrap); typeRow.appendChild(typeLabel);

    if (preview) {
      const previewEl = document.createElement('div');
      previewEl.textContent = preview;
      Object.assign(previewEl.style, {
        fontSize: '10.5px', color: '#666', lineHeight: '1.4',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        paddingLeft: '19px'
      });
      body.appendChild(typeRow); body.appendChild(previewEl);
    } else {
      body.appendChild(typeRow);
    }

    toast.appendChild(head); toast.appendChild(body);
    wrapper.appendChild(toast);

    const anim = toast.animate(
      [
        { opacity: 0, transform: 'translateX(24px) scale(0.96)' },
        { opacity: 1, transform: 'translateX(0) scale(1)', offset: 0.12 },
        { opacity: 1, transform: 'translateX(0) scale(1)', offset: 0.82 },
        { opacity: 0, transform: 'translateX(12px) scale(0.97)' }
      ],
      { duration: failed ? 6000 : 2800, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', fill: 'forwards' }
    );

    anim.finished.finally(() => {
      try { toast.remove(); if (!wrapper.children.length) wrapper.remove(); } catch (_) {}
    });
  }

  async function sendCopiedText(rawText, source) {
    const text = normalizeClipboardText(rawText);
    if (!text) return false;
    await loadLastStored();
    const key = toComparisonKey(text);
    if (key && key === lastStoredTextKey) return false;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'COPIED_TEXT',
        text,
        source
      });
      if (response && (response.ok || response.result?.duplicate)) {
        lastStoredTextKey = key;
        lastStoredImageHash = '';
      }
      return Boolean(response && response.ok);
    } catch (error) {
      return false;
    }
  }

  async function sendCopiedImage(image, mime, source) {
    if (typeof image !== 'string' || !image) return false;
    await loadLastStored();
    const hash = imageQuickHash(image);
    // The background must see repeats: a matching note may need its missing Blob repaired.

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'COPIED_IMAGE',
        image,
        mime: mime || 'image/png',
        source
      });
      if (response && (response.ok || response.result?.duplicate)) {
        lastStoredImageHash = hash;
        lastStoredTextKey = '';
      }
      if (response?.error) showCaptureToast('image', 'Storage unavailable. Free disk space and try again.', true);
      return Boolean(response && response.ok);
    } catch (error) {
      return false;
    }
  }

  function targetLooksLikeImage(target) {
    if (!(target instanceof Element)) return false;
    if (target.closest('img, picture, canvas, svg image, [role="img"]')) return true;

    try {
      const style = window.getComputedStyle(target);
      return Boolean(style.backgroundImage && style.backgroundImage !== 'none');
    } catch (error) {
      return false;
    }
  }

  function requestClipboardImageCheck(delay = 0, retryDelay = 0) {
    pendingImageCheckToken += 1;
    const token = pendingImageCheckToken;

    try {
      window.clearTimeout(pendingImageCheckTimer);
      pendingImageCheckTimer = window.setTimeout(async () => {
        try {
          const response = await chrome.runtime.sendMessage({ type: 'CHECK_CLIPBOARD_IMAGE' });
          if ((!response || !response.ok) && retryDelay > 0 && token === pendingImageCheckToken) {
            requestClipboardImageCheck(retryDelay, 0);
          }
        } catch (error) {
          if (retryDelay > 0 && token === pendingImageCheckToken) {
            requestClipboardImageCheck(retryDelay, 0);
          }
        }
      }, delay);
    } catch (error) {
      // ignore
    }
  }

  async function readClipboardAfterInteraction() {
    if (readInProgress) return;
    readInProgress = true;

    try {
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        const clipboardText = await navigator.clipboard.readText();
        if (clipboardText && clipboardText.trim()) {
          await sendCopiedText(clipboardText, 'interaction-read');
          return;
        }
      }

      requestClipboardImageCheck(0, 420);
    } catch (error) {
      requestClipboardImageCheck(0, 420);
    } finally {
      readInProgress = false;
    }
  }

  function scheduleClipboardRead() {
    window.clearTimeout(interactionReadTimer);
    interactionReadTimer = window.setTimeout(() => {
      readClipboardAfterInteraction().catch(() => {});
    }, INTERACTION_READ_DELAY_MS);
  }

  function onKeydownInteraction(event) {
    if (!event.isTrusted) return;
    const isClipboardShortcut =
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      (event.key === 'c' || event.key === 'C' || event.key === 'x' || event.key === 'X');

    if (!isClipboardShortcut) return;
    scheduleClipboardRead();
  }

  function getCopiedText(event) {
    if (event.clipboardData) {
      const clipboardText = event.clipboardData.getData('text/plain');
      if (clipboardText) return clipboardText;
    }

    const selection = window.getSelection();
    if (selection) {
      const selectedText = selection.toString();
      if (selectedText) return selectedText;
    }

    const activeElement = document.activeElement;
    if (!activeElement || typeof activeElement.value !== 'string') return '';

    const start = activeElement.selectionStart;
    const end = activeElement.selectionEnd;
    if (typeof start === 'number' && typeof end === 'number' && end > start) {
      return activeElement.value.slice(start, end);
    }

    return '';
  }

  document.addEventListener(
    'copy',
    (event) => {
      if (!event.isTrusted) return;
      const text = getCopiedText(event);
      window.clearTimeout(interactionReadTimer);

      if (text) {
        sendCopiedText(text, 'copy-event').catch(() => {});
      } else {
        requestClipboardImageCheck(180, 420);
      }
    },
    true
  );

  document.addEventListener(
    'cut',
    (event) => {
      if (!event.isTrusted) return;
      const text = getCopiedText(event);
      window.clearTimeout(interactionReadTimer);
      if (text) {
        sendCopiedText(text, 'cut-event').catch(() => {});
      }
    },
    true
  );

  document.addEventListener('keydown', onKeydownInteraction, true);

  // Save settled, user-made selections and copy them for immediate pasting.
  let selectionCaptureTimer = 0;
  let selectionPointerDown = false;

  function selectionNodeExcluded(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element) return true;
    if (element.isContentEditable || element.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return true;
    const host = element.getRootNode?.().host;
    return Boolean(host && (host.id?.startsWith('ct-') || selectionNodeExcluded(host)));
  }

  function selectedPageText() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount
      || selectionNodeExcluded(selection.anchorNode) || selectionNodeExcluded(selection.focusNode)) return '';
    // A selection can start/end outside an editor while spanning its contents.
    const range = selection.getRangeAt(0);
    const root = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    for (const editor of root?.querySelectorAll('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]') || []) {
      if (range.intersectsNode(editor)) return '';
    }
    const text = normalizeClipboardText(selection.toString());
    return text.length <= 1_000_000 ? text : '';
  }

  function cancelSelectionCapture() {
    window.clearTimeout(selectionCaptureTimer);
  }

  async function copySelectedText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // HTTP pages may lack the async clipboard API. Chrome's clipboardWrite
      // permission also allows a plain-text copy through a temporary textarea.
      const selection = window.getSelection();
      const ranges = Array.from({ length: selection?.rangeCount || 0 }, (_, i) => selection.getRangeAt(i).cloneRange());
      const activeElement = document.activeElement;
      const previousFocusedEl = lastFocusedEl;
      const target = document.createElement('textarea');
      target.value = text;
      target.setAttribute('aria-hidden', 'true');
      Object.assign(target.style, { position: 'fixed', left: '-9999px', top: '0', opacity: '0' });
      (document.body || document.documentElement).appendChild(target);
      try {
        target.select();
        return document.execCommand('copy');
      } catch (_) {
        return false;
      } finally {
        target.remove();
        activeElement?.focus({ preventScroll: true });
        selection?.removeAllRanges();
        ranges.forEach(range => selection?.addRange(range));
        lastFocusedEl = previousFocusedEl;
      }
    }
  }

  function scheduleSelectionCapture(event) {
    if (!event.isTrusted || event.composedPath?.().some(node => node?.id?.startsWith('ct-'))) return;
    cancelSelectionCapture();
    const text = selectedPageText();
    if (!text) return;
    selectionCaptureTimer = window.setTimeout(async () => {
      try {
        const state = await chrome.storage.local.get('qn_capture_enabled');
        if (state.qn_capture_enabled === false || selectionPointerDown
          || document.visibilityState === 'hidden' || selectedPageText() !== text) return;
        const copied = await copySelectedText(text);
        await sendCopiedText(text, 'selection');
        if (!copied) showCaptureToast('text', 'Press Cmd+C or Ctrl+C to copy this selection.', false, 'Auto-copy blocked');
      } catch (_) {
        // A disconnected/updated extension must not replace the clipboard.
      }
    }, event.type === 'keyup' ? 120 : 0);
  }

  document.addEventListener('pointerdown', event => {
    if (!event.isTrusted) return;
    selectionPointerDown = true;
    cancelSelectionCapture();
  }, true);
  document.addEventListener('pointerup', event => {
    if (!event.isTrusted) return;
    selectionPointerDown = false;
    scheduleSelectionCapture(event);
  }, true);
  document.addEventListener('pointercancel', event => {
    if (!event.isTrusted) return;
    selectionPointerDown = false;
    cancelSelectionCapture();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.isTrusted) cancelSelectionCapture();
  }, true);
  document.addEventListener('keyup', event => {
    const extendsSelection = event.shiftKey && /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|Shift)$/.test(event.key);
    const selectsAll = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a';
    if (extendsSelection || selectsAll) scheduleSelectionCapture(event);
  }, true);

  // Programmatic copy buttons are captured by extension-owned clipboard polling.
  // Never accept image/text payloads from the page's window.postMessage bridge.


  // ── Insert into focused element ────────────────────────────────────────────

  function injectText(el, text) {
    if (!el || !text) return;
    el.focus();
    if (el.isContentEditable) {
      if (!document.execCommand('insertText', false, text)) {
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true, cancelable: true, inputType: 'insertText', data: text
        }));
      }
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + text + el.value.slice(end);
      if (nativeSetter) nativeSetter.call(el, next); else el.value = next;
      el.selectionStart = el.selectionEnd = start + text.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function findEditable(root = document) {
    const direct = root.querySelector('[contenteditable="true"]:not([aria-hidden="true"]), textarea');
    if (direct) return direct;
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) {
        const found = findEditable(host.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  function dataUrlToFile(dataUrl, mime, idx = 0, ts = Date.now()) {
    const [header, b64] = dataUrl.split(',');
    const type = mime || (header.match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = type.includes('png') ? 'png' : 'jpg';
    return new File([bytes], `image-${idx + 1}-${ts}.${ext}`, { type });
  }

  async function injectImages(el, images) {
    if (!el || !images.length) return;
    try {
      const ts = Date.now();
      const files = images.map(({ dataUrl, mime }, idx) => dataUrlToFile(dataUrl, mime, idx, ts));

      // Twitter/X: use drag-and-drop on the composer which handles multiple files
      const isTwitter = /^(twitter\.com|x\.com)$/.test(location.hostname);
      if (isTwitter && files.length > 0) {
        const composer = document.querySelector('[data-testid="tweetTextarea_0"]') || el;
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        composer.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        composer.dispatchEvent(new DragEvent('dragover',  { bubbles: true, cancelable: true, dataTransfer: dt }));
        composer.dispatchEvent(new DragEvent('drop',      { bubbles: true, cancelable: true, dataTransfer: dt }));
        return;
      }

      // Claude, ChatGPT and everything else: one paste event per image
      el.focus();
      for (const file of files) {
        const dt = new DataTransfer();
        dt.items.add(file);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 120));
      }
    } catch (_) {}
  }

  // ── Message listener ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return false;

    if (message.type === 'SHOW_CAPTURE_TOAST') {
      showCaptureToast(message.itemType || 'text', message.preview || message.text || '', message.failed === true);
      return false;
    }

    if (message.type === 'TOGGLE_PALETTE') {
      if (_paletteOpen) { _hidePalette(); } else { _showPalette(); }
      return false;
    }

    if (message.type === 'INSERT_ITEMS' && Array.isArray(message.items)) {
      let el = lastFocusedEl && lastFocusedEl.isConnected ? lastFocusedEl : findEditable();
      if (!el || !el.isConnected) { sendResponse({ ok: false, reason: 'no_target' }); return false; }
      (async () => {
        if (message.fromSidebar) {
          window.focus();
          await new Promise((r) => setTimeout(r, 220));
        } else {
          // Small delay so popup finishes closing and page regains focus
          await new Promise((r) => setTimeout(r, 80));
        }
        const imageItems = message.items.filter((i) => i.kind === 'image');
        const textItems = message.items.filter((i) => i.kind === 'text');
        if (textItems.length) {
          const combined = textItems.map(item => {
            if (item.noteType === 'code') return '```\n' + item.text.trim() + '\n```';
            return item.text;
          }).join('\n\n');
          injectText(el, combined);
        }
        if (imageItems.length) await injectImages(el, imageItems);
        sendResponse({ ok: true });
      })();
      return true;
    }

    return false;
  });

  // ── Command Palette ─────────────────────────────────────────────────────────

  let _paletteHost = null;
  let _paletteShadow = null;
  let _paletteOpen = false;
  let _paletteAllItems = [];
  let _paletteFiltered = [];
  let _paletteSelected = 0;
  const _imageDataUrlCache = new Map();

  function _typeColor(type) {
    if (type === 'code') return '#a78bfa';
    if (type === 'link') return '#60a5fa';
    if (type === 'image') return '#fbbf24';
    return '#94a3b8';
  }

  function _timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  function _paletteCSS() {
    return `
      .ct-backdrop {
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(0,0,0,0.55);
        display: flex; align-items: flex-start; justify-content: center;
        padding-top: 14vh;
        pointer-events: all;
        animation: ct-fade-in 0.12s ease;
      }
      @keyframes ct-fade-in { from { opacity:0 } to { opacity:1 } }
      .ct-panel {
        background: #141414; border: 1px solid rgba(255,255,255,0.1);
        border-radius: 12px; width: 600px;
        max-width: calc(100vw - 40px); max-height: 460px;
        display: flex; flex-direction: column; overflow: hidden;
        box-shadow: 0 32px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.05);
        animation: ct-slide-in 0.14s ease;
      }
      @keyframes ct-slide-in { from { opacity:0; transform:translateY(-8px) } to { opacity:1; transform:translateY(0) } }
      .ct-search-row {
        display: flex; align-items: center; gap: 10px;
        padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.07); flex-shrink:0;
      }
      .ct-search-icon { color: #555; flex-shrink:0; }
      .ct-search {
        flex:1; background:none; border:none; outline:none;
        font-size: 15px; color: #f0ede8;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        caret-color: #a78bfa;
      }
      .ct-search::placeholder { color: #444; }
      .ct-badge {
        font-size: 11px; color: #555;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        flex-shrink:0;
      }
      .ct-list { overflow-y: auto; flex:1; }
      .ct-list::-webkit-scrollbar { width: 3px; }
      .ct-list::-webkit-scrollbar-thumb { background:#2d2d2d; border-radius:2px; }
      .ct-item {
        display: flex; align-items: center; gap: 10px;
        padding: 9px 16px; cursor: pointer;
        transition: background 0.08s;
      }
      .ct-item:hover { background: rgba(255,255,255,0.04); }
      .ct-item.ct-sel { background: rgba(167,139,250,0.1); }
      .ct-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
      .ct-text {
        flex:1; font-size:13px; color:#c4cad6; min-width:0;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .ct-time {
        font-size:11px; color:#3a3a3a; flex-shrink:0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .ct-item.ct-sel .ct-time { color: #555; }
      .ct-enter-hint {
        font-size:11px; color:#a78bfa; flex-shrink:0; opacity:0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .ct-item.ct-sel .ct-enter-hint { opacity:1; }
      .ct-empty {
        text-align:center; padding:36px 16px; color:#444;
        font-size:13px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .ct-footer {
        border-top: 1px solid rgba(255,255,255,0.07);
        padding: 8px 16px; display:flex; gap:16px; flex-shrink:0; align-items:center;
      }
      .ct-hint {
        font-size:11px; color:#444; display:flex; align-items:center; gap:4px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .ct-kbd {
        background:#1e1e1e; border:1px solid rgba(255,255,255,0.1);
        border-radius:3px; padding:1px 5px; font-size:10px; color:#666;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .ct-copied {
        margin-left:auto; font-size:11px; color:#4ade80;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        opacity:0; transition:opacity 0.25s;
      }
      .ct-copied.show { opacity:1; }
      .ct-thumb {
        width:52px; height:38px; object-fit:cover; border-radius:4px;
        flex-shrink:0; background:#222; display:block;
      }
      .ct-thumb-ph {
        width:52px; height:38px; border-radius:4px; background:#222;
        flex-shrink:0; display:flex; align-items:center; justify-content:center;
        color:#444;
      }
    `;
  }

  function _paletteFilter(query) {
    const q = query.trim().toLowerCase();
    _paletteFiltered = q
      ? _paletteAllItems.filter((n) => (n.content || '').toLowerCase().includes(q) || (n.url || '').toLowerCase().includes(q))
      : _paletteAllItems.slice();
    _paletteSelected = 0;
  }

  function _paletteRenderList() {
    if (!_paletteShadow) return;
    const list = _paletteShadow.querySelector('.ct-list');
    const badge = _paletteShadow.querySelector('.ct-badge');
    if (!list) return;
    if (badge) badge.textContent = _paletteAllItems.length + ' items';

    if (!_paletteFiltered.length) {
      list.innerHTML = '<div class="ct-empty">Nothing captured yet</div>';
      return;
    }

    list.replaceChildren();
    _paletteFiltered.forEach((note, i) => {
      const isSelected = i === _paletteSelected;
      const row = document.createElement('div');
      row.className = `ct-item${isSelected ? ' ct-sel' : ''}`;
      row.dataset.idx = i;
      if (note.type === 'image') {
        if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(note.dataUrl || '')) {
          const thumb = document.createElement('img');
          thumb.className = 'ct-thumb';
          thumb.src = note.dataUrl;
          row.appendChild(thumb);
        } else {
          const placeholder = document.createElement('div');
          placeholder.className = 'ct-thumb-ph';
          if (note.imageId != null) placeholder.dataset.imageId = note.imageId;
          placeholder.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/></svg>';
          row.appendChild(placeholder);
        }
      } else {
        const dot = document.createElement('div');
        dot.className = 'ct-dot';
        dot.style.backgroundColor = _typeColor(note.type);
        row.appendChild(dot);
      }
      const text = document.createElement('div');
      text.className = 'ct-text';
      text.textContent = (note.content || '').slice(0, 120);
      const time = document.createElement('div');
      time.className = 'ct-time';
      time.textContent = _timeAgo(note.time);
      const hint = document.createElement('div');
      hint.className = 'ct-enter-hint';
      hint.textContent = '↵ copy';
      row.append(text, time, hint);
      list.appendChild(row);
    });

    list.querySelectorAll('.ct-item').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx, 10);
        _paletteCopyItem(idx);
      });
      el.addEventListener('mouseenter', () => {
        _paletteSelected = parseInt(el.dataset.idx, 10);
        _paletteHighlight();
      });
    });

    const selEl = list.querySelector('.ct-sel');
    if (selEl) selEl.scrollIntoView({ block: 'nearest' });

    _paletteLoadThumbnails();
  }

  function _paletteLoadThumbnails() {
    if (!_paletteShadow) return;
    _paletteShadow.querySelectorAll('.ct-thumb-ph[data-image-id]').forEach(async (ph) => {
      const imageId = parseInt(ph.dataset.imageId, 10);
      try {
        const result = await chrome.runtime.sendMessage({ type: 'GET_IMAGE', imageId });
        if (result?.dataUrl && ph.isConnected) {
          _imageDataUrlCache.set(imageId, result.dataUrl);
          const img = document.createElement('img');
          img.className = 'ct-thumb';
          img.src = result.dataUrl;
          ph.replaceWith(img);
        }
      } catch (_) {}
    });
  }

  function _paletteHighlight() {
    if (!_paletteShadow) return;
    _paletteShadow.querySelectorAll('.ct-item').forEach((el, i) => {
      el.classList.toggle('ct-sel', i === _paletteSelected);
    });
    const selEl = _paletteShadow.querySelector('.ct-sel');
    if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  }

  async function _paletteCopyItem(idx) {
    const note = _paletteFiltered[idx];
    if (!note) return;

    try {
      if (note.type === 'image') {
        let dataUrl = note.dataUrl || _imageDataUrlCache.get(note.imageId);
        if (!dataUrl && note.imageId != null) {
          const r = await chrome.runtime.sendMessage({ type: 'GET_IMAGE', imageId: note.imageId });
          dataUrl = r?.dataUrl;
          if (dataUrl) _imageDataUrlCache.set(note.imageId, dataUrl);
        }
        if (dataUrl) {
          const pngBlob = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              canvas.getContext('2d').drawImage(img, 0, 0);
              canvas.toBlob((b) => b ? resolve(b) : reject(), 'image/png');
            };
            img.onerror = reject;
            img.src = dataUrl;
          });
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
        } else {
          await navigator.clipboard.writeText(note.content || '');
        }
      } else {
        const text = note.type === 'link' ? (note.url || note.content || '') : (note.full || note.content || '');
        await navigator.clipboard.writeText(text);
      }

      const copiedEl = _paletteShadow && _paletteShadow.querySelector('.ct-copied');
      if (copiedEl) {
        copiedEl.classList.add('show');
        setTimeout(() => copiedEl.classList.remove('show'), 1200);
      }
      setTimeout(() => _hidePalette(), 160);
    } catch (_) {}
  }

  function _paletteKeydown(e) {
    if (!_paletteOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); _hidePalette(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _paletteSelected = Math.min(_paletteSelected + 1, _paletteFiltered.length - 1);
      _paletteHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _paletteSelected = Math.max(_paletteSelected - 1, 0);
      _paletteHighlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      _paletteCopyItem(_paletteSelected);
    }
  }

  function _buildPaletteDOM() {
    const style = document.createElement('style');
    style.textContent = _paletteCSS();

    const backdrop = document.createElement('div');
    backdrop.className = 'ct-backdrop';
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) _hidePalette(); });

    const panel = document.createElement('div');
    panel.className = 'ct-panel';

    const searchRow = document.createElement('div');
    searchRow.className = 'ct-search-row';
    searchRow.innerHTML = `
      <svg class="ct-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input class="ct-search" placeholder="search tray…" autocomplete="off" spellcheck="false" />
      <span class="ct-badge"></span>
    `;

    const list = document.createElement('div');
    list.className = 'ct-list';

    const isApple = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
    const mod = isApple ? '⌘' : 'Ctrl';

    const footer = document.createElement('div');
    footer.className = 'ct-footer';
    footer.innerHTML = `
      <span class="ct-hint"><span class="ct-kbd">↑↓</span> navigate</span>
      <span class="ct-hint"><span class="ct-kbd">↵</span> copy</span>
      <span class="ct-hint"><span class="ct-kbd">Esc</span> close</span>
      <span class="ct-hint" style="margin-left:auto"><span class="ct-kbd">${mod}+Shift+E</span> save to tray</span>
      <span class="ct-copied">Copied!</span>
    `;

    panel.appendChild(searchRow);
    panel.appendChild(list);
    panel.appendChild(footer);
    backdrop.appendChild(panel);

    _paletteShadow.appendChild(style);
    _paletteShadow.appendChild(backdrop);

    const input = searchRow.querySelector('.ct-search');
    input.addEventListener('input', () => {
      _paletteFilter(input.value);
      _paletteRenderList();
    });
  }

  async function _showPalette() {
    if (!_paletteHost) {
      _paletteHost = document.createElement('div');
      _paletteHost.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;display:none;pointer-events:none;';
      document.documentElement.appendChild(_paletteHost);
      _paletteShadow = _paletteHost.attachShadow({ mode: 'open' });
      _buildPaletteDOM();
    }

    _paletteHost.style.display = 'block';
    _paletteHost.style.pointerEvents = 'all';

    const storage = await chrome.storage.local.get(STORAGE_KEY).catch(() => ({}));
    const data = storage[STORAGE_KEY] || {};
    const clusters = data.clusters || {};
    const all = [];
    Object.values(clusters).forEach((c) => (c.notes || []).forEach((n) => all.push(n)));
    all.sort((a, b) => b.time - a.time);
    _paletteAllItems = all.slice(0, 30);

    _paletteFilter('');
    _paletteRenderList();

    const input = _paletteShadow.querySelector('.ct-search');
    if (input) { input.value = ''; input.focus(); }

    _paletteOpen = true;
    document.addEventListener('keydown', _paletteKeydown, true);
  }

  function _hidePalette() {
    if (!_paletteHost || !_paletteOpen) return;
    _paletteOpen = false;
    document.removeEventListener('keydown', _paletteKeydown, true);
    _paletteHost.style.display = 'none';
    _paletteHost.style.pointerEvents = 'none';
  }

  // ── Palette message listener ─────────────────────────────────────────────────

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes[STORAGE_KEY]) {
      syncLastStoredFromQuicknotesValue(changes[STORAGE_KEY].newValue);
    }
  });

  loadLastStored().catch(() => {});
})();
