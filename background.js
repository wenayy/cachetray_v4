importScripts('shared.js', 'transfer-config.js', 'transfer-controller.js');

const {
  STORAGE_KEY, CAPTURE_KEY, COLORS, CAT_LIMIT,
  EXPIRY_MS, imgDbStore, imgDbGet, imgDbGetRetry, imgDbDeleteIfUnreferenced,
  normalizeStoredData, looksLikeUrl, toLinkUrl, detectType, guessLang,
  imageComparisonKey, noteComparisonKey, findDuplicateNote,
  ensureCluster, findOrCreateOverflow, injectImagesFunc,
} = CT;

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const CONTENT_SCRIPT_FILE = 'content-script.js';
const INJECTABLE_URL_PATTERNS = ['http://*/*', 'https://*/*', 'file:///*'];
const CLEANUP_ALARM = 'ct_cleanup';
const PHONE_SYNC_ALARM = 'ct_phone_sync';

function seedDemoData() {
  const now = Date.now();
  const min = 60 * 1000;
  const data = {
    uid: 5,
    current: 'inbox',
    currentCat: 'all',
    clusters: {
      inbox: {
        color: '#f87171',
        notes: [
          {
            id: 1, type: 'text', time: now,
            content: 'Welcome to CacheTray! Copy screenshots, links, or code — send them directly to Claude or ChatGPT without downloading files. Try it: copy any image right now.'
          },
          {
            id: 2, type: 'link', time: now - 2 * min,
            content: 'cachetray.gitflex.lol',
            url: 'https://cachetray.gitflex.lol/'
          },
          {
            id: 3, type: 'link', time: now - 6 * min,
            content: 'chromewebstore.google.com',
            url: 'https://chromewebstore.google.com'
          },
          {
            id: 4, type: 'code', time: now - 12 * min,
            content: '// CacheTray auto-detects code snippets',
            full: '// CacheTray auto-detects code snippets\nconst tray = "paste any code and it lands here";\nconsole.log(tray);',
            lang: 'js'
          },
          {
            id: 5, type: 'text', time: now - 25 * min,
            content: 'Open CacheTray anytime with Ctrl+Shift+Y  (⌘+Shift+Y on Mac) — no need to click the toolbar icon.'
          },
        ]
      }
    }
  };
  chrome.storage.local.set({ [STORAGE_KEY]: data });
}

async function loadData() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const parsed = stored[STORAGE_KEY];
  if (parsed && parsed.clusters) return normalizeStoredData(parsed);
  return {
    clusters: { inbox: { color: COLORS[0], notes: [] } },
    uid: 0, current: 'inbox', currentCat: 'all'
  };
}

async function saveData(data) {
  data.modifiedAt = Date.now();
  // Never delete a Blob before metadata commits. With unlimitedStorage, normal
  // writes do not need destructive quota-pruning; a failed write must preserve
  // the previous notes and their images.
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

async function compressImageDataUrl(dataUrl, maxDimension = 1920) {
  try {
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    let { width, height } = bitmap;
    if (width > maxDimension || height > maxDimension) {
      const scale = maxDimension / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const isPhoto = blob.type === 'image/jpeg' || blob.type === 'image/webp';
    const outType = isPhoto ? 'image/jpeg' : 'image/webp';
    const quality = isPhoto ? 0.88 : 0.92;
    const compressed = await canvas.convertToBlob({ type: outType, quality });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(compressed);
    });
  } catch (_) {
    return dataUrl;
  }
}

let saveQueue = Promise.resolve();
let pendingClipboardReadPromise = null;
let lastClipboardReadAt = 0;
let imageCapturesPausedUntil = 0;

function imageNameFromTab(tab) {
  const d = new Date();
  let h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const time = `${h}:${m} ${ampm}`;
  try {
    if (tab && tab.url) {
      const url = new URL(tab.url);
      const domain = url.hostname.replace(/^www\./, '');
      if (domain && domain !== 'newtab') return `${domain} · ${time}`;
    }
  } catch (_) {}
  return `Screenshot · ${time}`;
}

function enqueueSave(task) {
  const run = saveQueue.then(task, task);
  saveQueue = run.catch((err) => { console.error('CacheTray save failed:', err); });
  return run;
}

async function addStoredNote(rawText, options = {}) {
  if (!options.force) {
    const capState = await chrome.storage.local.get(CAPTURE_KEY);
    if (capState[CAPTURE_KEY] === false) return null;
  }

  const text = (rawText || '').trim();
  if (!text && !options.dataUrl) return null;

  const data = await loadData();
  const clusterName = options.cluster || data.current || 'inbox';
  ensureCluster(data.clusters, clusterName);

  const type = options.type || detectType(text);
  const note = {
    id: ++data.uid,
    type,
    content: options.content || text || options.filename || 'captured item',
    time: Date.now()
  };

  if (type === 'task') note.done = false;
  if (type === 'code') {
    note.full = text;
    note.lang = guessLang(text);
    note.content = text.split('\n')[0] || text;
  }
  if (type === 'link') note.url = options.url || toLinkUrl(text);
  if (options.sub) note.sub = options.sub;
  if (options.mime) note.mime = options.mime;
  let imageBlob = null;
  let compressedImageHash = '';
  if (options.dataUrl) {
    note.imageHash = imageComparisonKey(options.dataUrl);
    try {
      const compressed = await compressImageDataUrl(options.dataUrl);
      compressedImageHash = imageComparisonKey(compressed);
      imageBlob = await fetch(compressed).then((r) => r.blob());
      note.mime = imageBlob.type;
    } catch (_) {
      note.dataUrl = options.dataUrl;
    }
  }
  if (options.imageUrl) note.imageUrl = options.imageUrl;

  const existing = data.clusters[clusterName].notes.filter((item) => item.type === type).length;
  const targetCluster = existing >= CAT_LIMIT ? findOrCreateOverflow(data.clusters, clusterName, type) : clusterName;

  const dup = findDuplicateNote(data.clusters, note)
    || (compressedImageHash && compressedImageHash !== note.imageHash
      ? findDuplicateNote(data.clusters, { ...note, imageHash: compressedImageHash }) : null);
  if (dup) {
    if (type === 'image' && options.dataUrl && dup.note.imageId != null
      && !await imgDbGetRetry(dup.note.imageId)) {
      try {
        dup.note.imageId = await imgDbStore(imageBlob || await fetch(options.dataUrl).then(r => r.blob()));
        delete dup.note.dataUrl;
      } catch (error) {
        console.warn('CacheTray: IndexedDB repair failed; retaining inline image', error);
        dup.note.dataUrl = options.dataUrl;
        delete dup.note.imageId;
      }
      dup.note.mime = note.mime || options.mime;
    }
    if (type === 'image' && options.dataUrl) dup.note.imageHash = note.imageHash;
    dup.note.time = Date.now();
    const dupCluster = data.clusters[dup.clusterName];
    dupCluster.notes = [dup.note, ...dupCluster.notes.filter((n) => n !== dup.note)];
    await saveData(data);
    return { note: dup.note, cluster: dup.clusterName, bumped: true };
  }

  if (imageBlob) {
    try {
      note.imageId = await imgDbStore(imageBlob);
    } catch (error) {
      console.warn('CacheTray: IndexedDB image write failed; retaining inline image', error);
      note.dataUrl = options.dataUrl;
    }
  }

  data.clusters[targetCluster].notes.unshift(note);
  data.current = targetCluster;
  data.currentCat = type;

  await saveData(data);
  return { note, cluster: targetCluster };
}

// ── Offscreen document ───────────────────────────────────────────────────────

let creatingOffscreenDocument;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  if ('getContexts' in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length > 0) return;
  }
  if (creatingOffscreenDocument) { await creatingOffscreenDocument; return; }
  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['CLIPBOARD'],
    justification: 'Monitor clipboard so screenshots, links, and text can be staged for AI prompts without saving to disk.'
  });
  try { await creatingOffscreenDocument; } finally { creatingOffscreenDocument = null; }
}

async function readClipboardViaOffscreen() {
  if (pendingClipboardReadPromise) return pendingClipboardReadPromise;
  pendingClipboardReadPromise = (async () => {
    await ensureOffscreenDocument();
    const sinceLastRead = Date.now() - lastClipboardReadAt;
    if (sinceLastRead > 0 && sinceLastRead < 120) {
      await new Promise((r) => setTimeout(r, 120 - sinceLastRead));
    } else {
      await new Promise((r) => setTimeout(r, 60));
    }
    try {
      const result = await chrome.runtime.sendMessage({ type: 'READ_CLIPBOARD' });
      lastClipboardReadAt = Date.now();
      return result;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 220));
      try {
        const retryResult = await chrome.runtime.sendMessage({ type: 'READ_CLIPBOARD' });
        lastClipboardReadAt = Date.now();
        return retryResult;
      } catch (_) { return null; }
    } finally {
      pendingClipboardReadPromise = null;
    }
  })();
  return pendingClipboardReadPromise;
}

// ── Content script injection ─────────────────────────────────────────────────

async function hasHostPermission() {
  return chrome.permissions.contains({ origins: ['https://*/*', 'http://*/*'] });
}

async function registerContentScripts() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['qn-main'] });
    if (existing.length > 0) return;
    await chrome.scripting.registerContentScripts([{
      id: 'qn-main',
      matches: ['https://*/*', 'http://*/*'],
      js: [CONTENT_SCRIPT_FILE],
      runAt: 'document_idle',
      persistAcrossSessions: true
    }]);
  } catch (_) {}
}

async function injectContentScriptIntoOpenTabs() {
  if (!await hasHostPermission()) return;
  const tabs = await chrome.tabs.query({ url: INJECTABLE_URL_PATTERNS });
  await Promise.all(tabs.map(async (tab) => {
    if (!tab || typeof tab.id !== 'number') return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: [CONTENT_SCRIPT_FILE]
      });
    } catch (_) {}
  }));
}

chrome.permissions.onAdded.addListener(async (permissions) => {
  if (permissions.origins && permissions.origins.length > 0) {
    await registerContentScripts();
    await injectContentScriptIntoOpenTabs();
  }
});

// ── Toast helper ─────────────────────────────────────────────────────────────

async function maybeSendCaptureToast(tabId, result, fallbackType) {
  if (typeof tabId !== 'number') return;
  if (!result || result.duplicate) return;
  const itemType = result.note?.type || fallbackType || 'text';
  const note = result.note || {};
  let preview = '';
  if (itemType === 'link') preview = note.url || note.content || '';
  else if (itemType === 'image') preview = note.content || 'Screenshot';
  else preview = note.content || '';
  if (preview.length > 52) preview = preview.slice(0, 52) + '…';
  try { await chrome.tabs.sendMessage(tabId, { type: 'SHOW_CAPTURE_TOAST', itemType, preview }); } catch (_) {}
}

// ── Context menus ────────────────────────────────────────────────────────────

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'quicknotes-save-selection', title: 'Add to AI prompt (CacheTray)', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'quicknotes-save-link', title: 'Add link to AI prompt (CacheTray)', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'quicknotes-save-image', title: 'Add image to AI prompt (CacheTray)', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'quicknotes-save-page', title: 'Add page to AI prompt (CacheTray)', contexts: ['page'] });
  });
}

// ── Periodic cleanup (3-day expiry) ──────────────────────────────────────────

async function runCleanup() {
  const data = await loadData();
  const now = Date.now();
  let cleaned = 0;
  const removedImageIds = [];
  Object.keys(data.clusters).forEach((name) => {
    const before = data.clusters[name].notes;
    before.forEach(note => {
      if ((now - note.time) >= EXPIRY_MS && note.imageId != null) removedImageIds.push(note.imageId);
    });
    data.clusters[name].notes = before.filter((n) => (now - n.time) < EXPIRY_MS);
    cleaned += before.length - data.clusters[name].notes.length;
  });
  if (cleaned > 0) {
    await saveData(data);
    await Promise.allSettled(removedImageIds.map(id => imgDbDeleteIfUnreferenced(id)));
    console.log(`CacheTray: cleaned ${cleaned} expired items`);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLEANUP_ALARM) enqueueSave(runCleanup);
  if (alarm.name === PHONE_SYNC_ALARM) CacheTrayTransfer.syncClips().catch(() => {});
  if (alarm.name === 'ct_phone_connect') CacheTrayTransfer.resumeConnect().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[STORAGE_KEY]) {
    CacheTrayTransfer.scheduleClipSync();
  }
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'update') await chrome.storage.local.set({ ct_release_pending: chrome.runtime.getManifest().version });
  setupContextMenus();
  ensureOffscreenDocument().catch(() => {});
  chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 360 }); // every 6 hours
  chrome.alarms.clear('ct_cloud_sync'); // Remove the old Firebase preview alarm on update.
  chrome.alarms.create(PHONE_SYNC_ALARM, { periodInMinutes: 5 });
  if (await hasHostPermission()) {
    await registerContentScripts();
    injectContentScriptIntoOpenTabs().catch(() => {});
  }
  if (details.reason === 'install') seedDemoData();
});

chrome.runtime.onStartup.addListener(async () => {
  setupContextMenus();
  ensureOffscreenDocument().catch(() => {});
  chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 360 });
  chrome.alarms.clear('ct_cloud_sync');
  chrome.alarms.create(PHONE_SYNC_ALARM, { periodInMinutes: 5 });
  enqueueSave(runCleanup); // also clean on startup
  CacheTrayTransfer.resumeConnect().catch(() => {});
  CacheTrayTransfer.syncClips().catch(() => {});
  if (await hasHostPermission()) {
    await registerContentScripts();
    injectContentScriptIntoOpenTabs().catch(() => {});
  }
});

// ── Context menu handler ─────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'quicknotes-save-selection' && info.selectionText) {
    const result = await enqueueSave(() => addStoredNote(info.selectionText));
    await maybeSendCaptureToast(tab?.id, result, detectType(info.selectionText));
    return;
  }
  if (info.menuItemId === 'quicknotes-save-link' && info.linkUrl) {
    const label = info.linkText || info.linkUrl;
    const result = await enqueueSave(() => addStoredNote(label, { type: 'link', url: info.linkUrl, content: label }));
    await maybeSendCaptureToast(tab?.id, result, 'link');
    return;
  }
  if (info.menuItemId === 'quicknotes-save-page' && tab?.url) {
    const result = await enqueueSave(() => addStoredNote(tab.title || tab.url, { type: 'link', url: tab.url, content: tab.title || tab.url }));
    await maybeSendCaptureToast(tab?.id, result, 'link');
    return;
  }
  if (info.menuItemId === 'quicknotes-save-image' && info.srcUrl) {
    try {
      const response = await fetch(info.srcUrl, { referrer: tab?.url || '', credentials: 'omit' });
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      const nameFromUrl = info.srcUrl.split('/').pop()?.split('?')[0] || 'captured-image';
      const result = await enqueueSave(() => addStoredNote(nameFromUrl, { type: 'image', filename: nameFromUrl, dataUrl }));
      await maybeSendCaptureToast(tab?.id, result, 'image');
    } catch (error) {
      console.error('Failed to capture image', error);
    }
  }
});

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false;

  if (message.type === 'GET_IMAGE' && message.imageId != null) {
    (async () => {
      try {
        const blob = await CT.imgDbGetRetry(message.imageId);
        if (!blob) { sendResponse({ error: 'not found' }); return; }
        const reader = new FileReader();
        reader.onload = () => sendResponse({ dataUrl: reader.result, mime: blob.type });
        reader.onerror = () => sendResponse({ error: 'read failed' });
        reader.readAsDataURL(blob);
      } catch (e) {
        sendResponse({ error: String(e) });
      }
    })();
    return true;
  }

  (async () => {
    const senderTabId = sender?.tab?.id;
    try {

      if (message.type === 'TRANSFER_DEVICES') {
        const account = CacheTrayTransfer.configured() ? await CacheTrayTransfer.accountStatus().catch(() => null) : null;
        sendResponse({ ok: true, devices: await CacheTrayTransfer.devices(), configured: CacheTrayTransfer.configured(),
          account });
        return;
      }
      if (message.type === 'BILLING_PREPARE') {
        sendResponse({ ok: true, ...await CacheTrayTransfer.prepareBilling(message.newKey === true) });
        return;
      }
      if (message.type === 'BILLING_ACTION') {
        if (!['checkout', 'portal', 'restore'].includes(message.action)) throw new Error('Invalid billing action');
        const result = await CacheTrayTransfer.billingAction(message.action, message.recoveryKey);
        const url = result.checkoutUrl || result.portalUrl;
        if (url) await chrome.tabs.create({ url });
        sendResponse({ ok: true, result });
        return;
      }
      if (message.type === 'TRANSFER_PAIR') {
        sendResponse({ ok: true, devices: await CacheTrayTransfer.pair(message.code) });
        return;
      }
      if (message.type === 'TRANSFER_CONNECT_START') {
        sendResponse({ ok: true, session: await CacheTrayTransfer.startConnect() });
        return;
      }
      if (message.type === 'TRANSFER_CONNECT_STATUS') {
        sendResponse({ ok: true, result: await CacheTrayTransfer.connectStatus(message.session) });
        return;
      }
      if (message.type === 'TRANSFER_CONNECT_PENDING') {
        sendResponse({ ok: true, session: await CacheTrayTransfer.pendingConnect() });
        return;
      }
      if (message.type === 'TRANSFER_DISCONNECT') {
        sendResponse({ ok: true, devices: await CacheTrayTransfer.disconnect(message.receiverDeviceId) });
        return;
      }
      if (message.type === 'TRANSFER_SEND_IMAGE') {
        sendResponse({ ok: true, result: await CacheTrayTransfer.send(message.imageId, message.filename, message.receiverDeviceId) });
        return;
      }

      if (message.type === 'COPIED_TEXT' && typeof message.text === 'string') {
        const result = await enqueueSave(() => addStoredNote(message.text, {}));
        sendResponse({ ok: Boolean(result && !result.duplicate), result });
        await maybeSendCaptureToast(senderTabId, result, detectType(message.text));
        return;
      }

      if (message.type === 'PAUSE_IMAGE_CAPTURE') {
        imageCapturesPausedUntil = Date.now() + 7000;
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'COPIED_IMAGE' && typeof message.image === 'string') {
        if (Date.now() < imageCapturesPausedUntil) { sendResponse({ ok: false, skipped: true }); return; }
        const imgName = imageNameFromTab(sender.tab);
        const result = await enqueueSave(() => addStoredNote(imgName, {
          type: 'image', filename: 'copied-image', dataUrl: message.image, mime: message.mime
        }));
        sendResponse({ ok: Boolean(result && !result.duplicate), result });
        await maybeSendCaptureToast(senderTabId, result, 'image');
        return;
      }

      if (message.type === 'CHECK_CLIPBOARD_IMAGE') {
        if (Date.now() < imageCapturesPausedUntil) { sendResponse({ ok: false, skipped: true }); return; }
        const clipResult = await readClipboardViaOffscreen();
        if (clipResult && clipResult.image) {
          const imgName = imageNameFromTab(sender.tab);
          const result = await enqueueSave(() => addStoredNote(imgName, {
            type: 'image', filename: 'copied-image', dataUrl: clipResult.image, mime: clipResult.mime
          }));
          sendResponse({ ok: Boolean(result && !result.duplicate), result });
          await maybeSendCaptureToast(senderTabId, result, 'image');
          return;
        }
        sendResponse({ ok: false });
        return;
      }

      if (message.type === 'quicknotes-capture-copy') {
        let result = null;
        if (message.payload?.dataUrl) {
          result = await enqueueSave(() => addStoredNote(message.payload.filename || 'copied image', {
            type: 'image', filename: message.payload.filename, dataUrl: message.payload.dataUrl
          }));
        } else if (message.payload?.imageUrl) {
          const filename = message.payload.filename || message.payload.imageUrl.split('/').pop()?.split('?')[0] || 'copied-image';
          result = await enqueueSave(() => addStoredNote(filename, {
            type: 'image', filename, imageUrl: message.payload.imageUrl
          }));
        } else if (message.payload?.url) {
          result = await enqueueSave(() => addStoredNote(message.payload.content || message.payload.url, {
            type: 'link', url: message.payload.url, content: message.payload.content || message.payload.url
          }));
        } else if (message.payload?.text) {
          result = await enqueueSave(() => addStoredNote(message.payload.text, {
            type: message.payload.forcedType || undefined
          }));
        }
        sendResponse({ ok: Boolean(result && !result.duplicate), result });
        await maybeSendCaptureToast(senderTabId, result, result?.note?.type);
        return;
      }

      sendResponse({ ok: false });
    } catch (error) {
      console.error('CacheTray message failed', error);
      if (senderTabId && (message.type === 'CHECK_CLIPBOARD_IMAGE'
        || (message.type === 'quicknotes-capture-copy' && (message.payload?.dataUrl || message.payload?.imageUrl)))) {
        chrome.tabs.sendMessage(senderTabId, {
          type: 'SHOW_CAPTURE_TOAST', itemType: 'image', failed: true,
          preview: 'Storage unavailable. Free disk space and try again.'
        }).catch(() => {});
      }
      sendResponse({ ok: false, error: error?.message || String(error), code: error?.code, limits: error?.limits });
    }
  })();

  return true;
});

// ── Inject pending AI items on Claude/ChatGPT tab load ───────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (!/claude\.ai|chatgpt\.com/.test(tab.url)) return;

  let pending;
  try {
    ({ ct_pending_ai: pending } = await chrome.storage.session.get('ct_pending_ai'));
  } catch (_) { return; }
  if (!pending) return;

  await chrome.storage.session.remove('ct_pending_ai');

  const { items } = pending;
  const textItems = items.filter((i) => i.kind === 'text');
  const imageItems = items.filter((i) => i.kind === 'image');

  if (textItems.length) {
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { type: 'INSERT_ITEMS', items: textItems, fromSidebar: true }).catch(() => {});
    }, 800);
  }

  if (imageItems.length) {
    setTimeout(() => {
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: injectImagesFunc,
        args: [imageItems]
      }).catch(() => {});
    }, 1200);
  }
});

// ── Keyboard commands ────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle_palette') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PALETTE' }).catch(() => {});
    return;
  }
  if (command === 'save_to_tray') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab?.id;
    try {
      const clip = await readClipboardViaOffscreen();
      if (clip?.text) {
        const result = await enqueueSave(() => addStoredNote(clip.text, { force: true }));
        if (tabId) await maybeSendCaptureToast(tabId, result, detectType(clip.text));
      } else if (clip?.image) {
        const imgName = tab ? imageNameFromTab(tab) : 'screenshot';
        const result = await enqueueSave(() => addStoredNote(imgName, {
          type: 'image', filename: 'copied-image', dataUrl: clip.image, mime: clip.mime, force: true
        }));
        if (tabId) await maybeSendCaptureToast(tabId, result, 'image');
      }
    } catch (_) {}
    return;
  }
});

// ── Startup ──────────────────────────────────────────────────────────────────

ensureOffscreenDocument().catch((error) => {
  console.error('Failed to initialize offscreen clipboard monitor', error);
});
injectContentScriptIntoOpenTabs().catch((error) => {
  console.error('Failed to inject content script at startup', error);
});
