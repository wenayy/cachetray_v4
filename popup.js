const {
  STORAGE_KEY, CAPTURE_KEY, COLORS, CAT_LIMIT,
  imgDbStore, imgDbGet, imgDbGetRetry, imgDbDeleteIfUnreferenced,
  imageComparisonKey, normalizeStoredData,
  looksLikeUrl, toLinkUrl, looksLikeCode, detectType, guessLang,
  injectImagesFunc,
} = CT;

const IS_SIDEBAR = location.pathname.endsWith('sidebar.html');
const THEME_KEY = 'ct_theme';
const TYPE_COLOR = { code: '#a78bfa', link: '#60a5fa', task: '#f87171', image: '#fbbf24', text: 'rgba(255,255,255,0.15)' };

const imgObjectUrlCache = new Map();

async function getImageObjectUrl(note) {
  if (note.imageId == null) return note.dataUrl || note.imageUrl || null;
  if (imgObjectUrlCache.has(note.id)) return imgObjectUrlCache.get(note.id);
  const blob = await imgDbGetRetry(note.imageId);
  if (!blob) return note.dataUrl || note.imageUrl || note.thumb || null;
  const url = URL.createObjectURL(blob);
  imgObjectUrlCache.set(note.id, url);
  return url;
}

function generateThumb(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 80;
      let w = img.naturalWidth, h = img.naturalHeight;
      const s = MAX / Math.max(w, h);
      w = Math.round(w * s); h = Math.round(h * s);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.5));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function revokeImgCache(noteId) {
  const url = imgObjectUrlCache.get(noteId);
  if (url) { URL.revokeObjectURL(url); imgObjectUrlCache.delete(noteId); }
}

let uid = 0;
let clusters = { inbox: { color: COLORS[0], notes: [] } };
let current = 'inbox';
let currentCat = 'all';
let lastDel = null;
let undoTimer = null;
let selectedIds = new Set();
let renamingNoteId = null;
let captureEnabled = true;
let searchQuery = '';
let searchAllWorkspaces = false;
let imageViewMode = localStorage.getItem('ct_imageViewMode') || 'list';

function isLightTheme() {
  return document.documentElement.classList.contains('light');
}

function linkDisplayName(href) {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./, '');
    // For chrome:// and other non-http schemes use scheme + host
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      const label = (u.protocol.replace(':', '') + '://' + host).slice(0, 40);
      return label.charAt(0).toUpperCase() + label.slice(1);
    }
    // Use first non-empty path segment as context, if meaningful
    const seg = u.pathname.split('/').find((s) => s.length > 2 && !/^\d+$/.test(s));
    const name = seg ? `${host} › ${seg.replace(/-/g, ' ')}` : host;
    return name.length > 48 ? name.slice(0, 48) + '…' : name;
  } catch (_) {
    return href.length > 48 ? href.slice(0, 48) + '…' : href;
  }
}

function saveData() {
  return chrome.storage.local.set({
    [STORAGE_KEY]: {
      clusters,
      uid,
      current,
      currentCat,
      modifiedAt: Date.now()
    }
  });
}

function seedDemoData() {
  const now = Date.now();
  const min = 60 * 1000;
  clusters.inbox.notes = [
    {
      id: ++uid, type: 'text', time: now,
      content: 'Welcome to CacheTray! Copy anything on any website — links, screenshots, code — and it appears here instantly. Try it: copy any text or image right now.'
    },
    {
      id: ++uid, type: 'link', time: now - 6 * min,
      content: 'chromewebstore.google.com',
      url: 'https://chromewebstore.google.com'
    },
    {
      id: ++uid, type: 'code', time: now - 12 * min,
      content: '// CacheTray auto-detects code snippets',
      full: '// CacheTray auto-detects code snippets\nconst tray = "paste any code and it lands here";\nconsole.log(tray);',
      lang: 'js'
    },
    {
      id: ++uid, type: 'text', time: now - 25 * min,
      content: 'Open CacheTray anytime with Ctrl+Shift+Y  (⌘+Shift+Y on Mac) — no need to click the toolbar icon.'
    },
  ];
  saveData();
}

async function loadData() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const parsed = stored[STORAGE_KEY];
  if (parsed?.clusters) {
    const normalized = normalizeStoredData(parsed);
    clusters = normalized.clusters;
    uid = normalized.uid || 0;
    current = normalized.current || 'inbox';
    currentCat = normalized.currentCat || 'all';
  } else {
    seedDemoData();
  }
  if (!clusters[current]) current = Object.keys(clusters)[0] || 'inbox';
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[THEME_KEY]) {
    applyTheme(changes[THEME_KEY].newValue === 'light' ? 'light' : 'dark');
  }
  if (changes[STORAGE_KEY]) {
    const next = normalizeStoredData(changes[STORAGE_KEY].newValue);
    if (!next?.clusters) return;
    clusters = next.clusters;
    uid = next.uid || 0;
    current = next.current || current;
    currentCat = next.currentCat || currentCat;
    if (!clusters[current]) current = Object.keys(clusters)[0] || 'inbox';
    renderAll();
  }
});

function getTimeStr(time) {
  if (!time) return 'just now';
  const mins = Math.floor((Date.now() - time) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins > 1 ? 's' : ''} ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours} hr${hours > 1 ? 's' : ''} ago` : `${Math.floor(hours / 24)} d ago`;
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => execCopy(text));
  }
  return Promise.resolve(execCopy(text));
}

function execCopy(text) {
  const input = document.createElement('textarea');
  input.value = text;
  input.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.appendChild(input);
  input.focus();
  input.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (error) {
    ok = false;
  }
  document.body.removeChild(input);
  return ok;
}

function getImageSource(note) {
  if (!note || typeof note !== 'object') return '';
  return note.dataUrl || note.imageUrl || '';
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime = (header.match(/:(.*?);/) || [])[1] || 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let index = 0; index < bin.length; index += 1) {
    bytes[index] = bin.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

function blobToPng(blob) {
  return new Promise((resolve, reject) => {
    if (!blob) {
      reject(new Error('Missing image blob'));
      return;
    }
    if (blob.type === 'image/png') {
      resolve(blob);
      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas context unavailable');
        context.drawImage(image, 0, 0);
        canvas.toBlob((pngBlob) => {
          URL.revokeObjectURL(objectUrl);
          if (pngBlob) resolve(pngBlob);
          else reject(new Error('PNG conversion failed'));
        }, 'image/png');
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        reject(error);
      }
    };
    image.onerror = (error) => {
      URL.revokeObjectURL(objectUrl);
      reject(error);
    };
    image.src = objectUrl;
  });
}

function compressBlob(blob, maxDimension = 1920) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { naturalWidth: w, naturalHeight: h } = img;
      if (w > maxDimension || h > maxDimension) {
        const s = maxDimension / Math.max(w, h);
        w = Math.round(w * s); h = Math.round(h * s);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);

      // Screenshots (PNG) → WebP at high quality: no JPEG artifacts on text/UI, ~70% smaller than PNG
      // Photos (JPEG/WebP) → JPEG at higher quality for better fidelity
      const isPhoto = blob.type === 'image/jpeg' || blob.type === 'image/webp';
      const outType = isPhoto ? 'image/jpeg' : 'image/webp';
      const quality = isPhoto ? 0.88 : 0.92;

      canvas.toBlob((compressed) => {
        if (compressed) { resolve(compressed); return; }
        // WebP not supported — fall back to JPEG
        canvas.toBlob((fb) => resolve(fb || blob), 'image/jpeg', 0.88);
      }, outType, quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(blob); };
    img.src = url;
  });
}

async function getNoteImageBlob(note, { forcePng = false } = {}) {
  let blob;
  if (note.imageId != null) {
    blob = await imgDbGetRetry(note.imageId);
    if (!blob && note.dataUrl) blob = dataUrlToBlob(note.dataUrl);
    if (!blob) return null;
  } else {
    const source = getImageSource(note);
    if (!source) return null;
    blob = source.startsWith('data:') ? dataUrlToBlob(source) : await fetch(source).then((r) => r.blob());
  }
  return forcePng ? blobToPng(blob) : blob;
}

async function getNoteImageDataUrl(note) {
  if (note.imageId != null) {
    const blob = await imgDbGetRetry(note.imageId);
    return blob ? blobToDataUrl(blob) : (note.dataUrl || '');
  }
  const source = getImageSource(note);
  if (!source) return '';
  if (source.startsWith('data:')) return source;
  const blob = await getNoteImageBlob(note);
  return blob ? blobToDataUrl(blob) : '';
}

function createClipboardImageItem(blob) {
  const data = { [blob.type || 'image/png']: blob };
  try {
    return new ClipboardItem(data, { presentationStyle: 'attachment' });
  } catch (error) {
    return new ClipboardItem(data);
  }
}

function pauseImageCapture() {
  chrome.runtime.sendMessage({ type: 'PAUSE_IMAGE_CAPTURE' }).catch(() => {});
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function imageExtensionForNote(note) {
  const mime = note?.mime || (note?.dataUrl?.match(/^data:(image\/[^;]+)/)?.[1]) || '';
  if (/png/i.test(mime)) return 'png';
  if (/jpe?g/i.test(mime)) return 'jpg';
  if (/webp/i.test(mime)) return 'webp';
  if (/gif/i.test(mime)) return 'gif';
  if (/svg/i.test(mime)) return 'svg';

  const source = getImageSource(note);
  const extMatch = source.match(/\.([a-z0-9]+)(?:[\?#]|$)/i);
  return extMatch ? extMatch[1].toLowerCase() : 'png';
}

function downloadNameForNote(note) {
  const base = sanitizeFilenamePart(note?.content || 'quick-note-image') || 'quick-note-image';
  const ext = imageExtensionForNote(note);
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

const CHECK_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function doCopy(button, text) {
  copyText(text).then((ok) => {
    if (!ok) { button.classList.add('fail'); setTimeout(() => button.classList.remove('fail'), 1500); return; }
    const orig = button.innerHTML;
    button.innerHTML = CHECK_ICON_SVG;
    button.classList.add('ok');
    setTimeout(() => { button.innerHTML = orig; button.classList.remove('ok'); }, 1500);
  });
}

function copyBlock(button, text) {
  copyText(text).then((ok) => {
    const original = button.textContent;
    button.textContent = ok ? 'COPIED ✓' : 'FAILED';
    button.classList.add('ok');
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove('ok');
    }, 1600);
  });
}

async function copyImage(button, note) {
  try {
    const blob = await getNoteImageBlob(note, { forcePng: true });
    if (!blob) throw new Error('no blob');
    if (navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([createClipboardImageItem(blob)]);
      pauseImageCapture();
    } else {
      const source = getImageSource(note);
      if (source) await copyText(source);
    }
    const orig = button.innerHTML;
    button.innerHTML = CHECK_ICON_SVG;
    button.classList.add('ok');
    setTimeout(() => { button.innerHTML = orig; button.classList.remove('ok'); }, 1500);
  } catch (_) {
    button.classList.add('fail');
    setTimeout(() => button.classList.remove('fail'), 1500);
  }
}

async function downloadImage(note) {
  const url = await getImageObjectUrl(note);
  if (!url) return;
  const link = document.createElement('a');
  link.href = url;
  link.download = downloadNameForNote(note);
  link.click();
}

function renderAll() {
  const titleEl = document.getElementById('clusterTitle');
  if (titleEl && !document.getElementById('clusterNameWrap').querySelector('.title-input')) {
    titleEl.textContent = current;
  }
  renderTabs();
  renderCats();
  renderFeed();
  updateSelUI();
}

function scrollToVisible(container, el) {
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  if (eRect.right > cRect.right) {
    container.scrollLeft += eRect.right - cRect.right + 12;
  } else if (eRect.left < cRect.left) {
    container.scrollLeft -= cRect.left - eRect.left + 12;
  }
}

function renderTabs() {
  const tabs = document.getElementById('clusterTabs');
  tabs.innerHTML = '';
  Object.entries(clusters).forEach(([key, cluster]) => {
    const tab = document.createElement('div');
    tab.className = `c-tab${key === current ? ' active' : ''}`;
    tab.style.setProperty('--cluster-color', cluster.color);

    const dot = document.createElement('div');
    dot.className = 'c-dot';
    dot.style.background = cluster.color;
    tab.appendChild(dot);

    const label = document.createElement('span');
    label.textContent = key;
    tab.appendChild(label);

    if (key !== current) {
      const close = document.createElement('span');
      close.className = 'c-x';
      close.textContent = '×';
      close.onclick = async (event) => {
        event.stopPropagation();
        if (Object.keys(clusters).length <= 1) return;
        delete clusters[key];
        if (!clusters[current]) current = Object.keys(clusters)[0];
        await saveData();
        renderAll();
      };
      tab.appendChild(close);
    }

    tab.onclick = () => {
      current = key;
      currentCat = 'all';
      saveData();
      renderAll();
    };

    tabs.appendChild(tab);
  });

  const add = document.createElement('div');
  add.className = 'c-tab-add';
  add.textContent = '+ new';
  add.onclick = async () => {
    const tempKey = `cluster ${Object.keys(clusters).length + 1}`;
    clusters[tempKey] = {
      color: COLORS[Object.keys(clusters).length % COLORS.length],
      notes: []
    };
    current = tempKey;
    currentCat = 'all';
    await saveData();
    renderAll();
    setTimeout(startRename, 30);
  };
  tabs.appendChild(add);

  requestAnimationFrame(() => {
    const activeTab = tabs.querySelector('.c-tab.active');
    if (activeTab) scrollToVisible(tabs, activeTab);
    tabs.classList.toggle('overflowing', tabs.scrollWidth > tabs.clientWidth);
  });
}

function renderCats() {
  const notes = clusters[current].notes;
  const counts = { all: notes.length };
  let favCount = 0;
  notes.forEach((note) => {
    counts[note.type] = (counts[note.type] || 0) + 1;
    if (note.favorited) favCount++;
  });

  const row = document.getElementById('catRow');
  row.innerHTML = '';

  if (favCount > 0 || currentCat === 'favorites') {
    const favPill = document.createElement('div');
    favPill.className = `cat-pill fav-pill${currentCat === 'favorites' ? ' active' : ''}`;
    favPill.textContent = `favourites ${favCount}`;
    favPill.onclick = () => {
      currentCat = 'favorites';
      saveData();
      renderCats();
      renderFeed();
    };
    row.appendChild(favPill);
  }

  const CAT_META = {
    all:   { label: 'All',    icon: '' },
    link:  { label: 'Links',  icon: `<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>` },
    code:  { label: 'Code',   icon: `<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>` },
    image: { label: 'Images', icon: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>` },
    text:  { label: 'Text',   icon: `<svg viewBox="0 0 24 24"><line x1="21" y1="6" x2="3" y2="6"/><line x1="15" y1="12" x2="3" y2="12"/><line x1="17" y1="18" x2="3" y2="18"/></svg>` },
    task:  { label: 'Tasks',  icon: `<svg viewBox="0 0 24 24"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>` },
  };

  ['all', 'image', 'link', 'text', 'code'].forEach((category) => {
    if (category !== 'all' && !counts[category]) return;
    const count = counts[category] || 0;
    const nearFull = category !== 'all' && count >= CAT_LIMIT - 3;
    const isFull = category !== 'all' && count >= CAT_LIMIT;
    const meta = CAT_META[category] || { label: category, icon: '' };
    const pill = document.createElement('div');
    pill.className = `cat-pill${currentCat === category ? ' active' : ''}`;
    if (meta.icon) pill.innerHTML = meta.icon;
    const labelSpan = document.createElement('span');
    labelSpan.textContent = `${meta.label} ${count}${isFull ? ' ·split' : nearFull ? ` ·${count}/${CAT_LIMIT}` : ''}`;
    pill.appendChild(labelSpan);
    if (isFull && currentCat !== category) pill.style.borderColor = '#f87171';
    // Selection badge: show how many selected items live in this category
    const selInCat = category === 'all'
      ? clusters[current].notes.filter((n) => selectedIds.has(n.id)).length
      : clusters[current].notes.filter((n) => selectedIds.has(n.id) && n.type === category).length;
    if (selInCat > 0 && currentCat !== category) {
      const badge = document.createElement('span');
      badge.className = 'cat-sel-badge';
      badge.textContent = selInCat;
      pill.appendChild(badge);
    }
    pill.onclick = () => {
      currentCat = category;
      saveData();
      renderCats();
      renderFeed();
    };
    row.appendChild(pill);
  });

  if (currentCat === 'image') {
    const toggle = document.createElement('div');
    toggle.className = 'view-toggle';
    toggle.id = 'viewToggle';
    toggle.style.marginLeft = 'auto';

    const listBtn = document.createElement('button');
    listBtn.className = `view-toggle-btn${imageViewMode === 'list' ? ' active' : ''}`;
    listBtn.id = 'viewListBtn';
    listBtn.title = 'List view';
    listBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
    listBtn.onclick = () => {
      imageViewMode = 'list';
      localStorage.setItem('ct_imageViewMode', 'list');
      renderCats();
      renderFeed();
    };

    const gridBtn = document.createElement('button');
    gridBtn.className = `view-toggle-btn${imageViewMode === 'grid' ? ' active' : ''}`;
    gridBtn.id = 'viewGridBtn';
    gridBtn.title = 'Grid view';
    gridBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`;
    gridBtn.onclick = () => {
      imageViewMode = 'grid';
      localStorage.setItem('ct_imageViewMode', 'grid');
      renderCats();
      renderFeed();
    };

    toggle.appendChild(listBtn);
    toggle.appendChild(gridBtn);
    row.appendChild(toggle);
  }

}

function mkTag(label, color) {
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = label;
  tag.style.color = color;
  return tag;
}

function mkChev() {
  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('viewBox', '0 0 12 12');
  chevron.setAttribute('class', 'chev');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M2 4l4 4 4-4');
  chevron.appendChild(path);
  return chevron;
}

function mkIco(title, pathData, cls) {
  const wrapper = document.createElement('div');
  wrapper.className = `ico${cls ? ` ${cls}` : ''}`;
  wrapper.title = title;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 15 15');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  svg.appendChild(path);
  wrapper.appendChild(svg);
  return wrapper;
}

function mkFavIco(note) {
  const icon = mkIco('favorite', 'M7.5 1.5l1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z', note.favorited ? 'fav-on' : '');
  icon.onclick = (event) => {
    event.stopPropagation();
    toggleFavorite(note.id);
  };
  return icon;
}

function mkDelIco(note) {
  const icon = mkIco('delete', 'M2 4h11M5 4V2h5v2M6 7v5M9 7v5M3 4l1 9h7l1-9', 'del');
  icon.onclick = (event) => {
    event.stopPropagation();
    deleteNote(note.id);
  };
  return icon;
}

function mkRenameIco(note) {
  const icon = mkIco('rename', 'M2 10.5V13h2.5L11 6.5 8.5 4 2 10.5zM9.25 3.25l2.5 2.5 1-1a1.77 1.77 0 0 0 0-2.5l-.5-.5a1.77 1.77 0 0 0-2.5 0l-.5.5z', 'rename');
  icon.onclick = (event) => {
    event.stopPropagation();
    startNoteRename(note.id);
  };
  return icon;
}

function mkCopyPill(text) {
  const pill = document.createElement('div');
  pill.className = 'cpill';
  pill.textContent = 'copy';
  pill.onclick = (event) => {
    event.stopPropagation();
    doCopy(pill, text);
  };
  return pill;
}

const COPY_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

function mkRowCopyBtn(onClickFn) {
  const btn = document.createElement('button');
  btn.className = 'row-copy-btn';
  btn.title = 'Copy';
  btn.innerHTML = COPY_ICON_SVG;
  btn.onclick = (e) => { e.stopPropagation(); onClickFn(btn); };
  return btn;
}

const TYPE_ICONS = {
  link: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  code: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  text: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
  image: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  task: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
  task_done: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
};

function mkHov(children, note) {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:grid;margin-left:auto;flex-shrink:0;align-items:center;';
  wrapper.onclick = (event) => event.stopPropagation();

  const time = document.createElement('span');
  time.className = 'time-span';
  time.dataset.time = note.time || Date.now();
  time.style.cssText = 'grid-area:1/1;justify-self:end;white-space:nowrap;';
  time.textContent = getTimeStr(note.time);

  const controls = document.createElement('div');
  controls.className = 'hov';
  controls.style.cssText = 'grid-area:1/1;justify-self:end;display:flex;align-items:center;gap:5px;';
  children.forEach((child) => controls.appendChild(child));

  wrapper.appendChild(time);
  wrapper.appendChild(controls);
  return wrapper;
}

function startNoteRename(noteId) {
  renamingNoteId = noteId;
  renderFeed();
  requestAnimationFrame(() => {
    const input = document.querySelector(`[data-rename-input="${noteId}"]`);
    if (!input) return;
    input.focus();
    input.select();
  });
}

async function commitNoteRename(noteId, rawValue) {
  const nextValue = sanitizeFilenamePart(rawValue);
  const note = clusters[current].notes.find((item) => item.id === noteId);
  renamingNoteId = null;
  if (!note || !nextValue || nextValue === note.content) {
    renderFeed();
    return;
  }
  note.content = nextValue;
  await saveData();
  renderFeed();
}

function cancelNoteRename() {
  renamingNoteId = null;
  renderFeed();
}


function toggleRowExp(top) {
  const body = top.nextElementSibling;
  const chevron = top.querySelector('.chev');
  if (!body) return;
  const isOpen = body.classList.contains('open');
  document.querySelectorAll('.exp.open').forEach((element) => {
    element.classList.remove('open');
    const previousChevron = element.previousElementSibling?.querySelector('.chev');
    if (previousChevron) previousChevron.classList.remove('open');
  });
  if (!isOpen) {
    body.classList.add('open');
    if (chevron) chevron.classList.add('open');
  }
}

function buildRow(note, index, activeQuery) {
  const row = document.createElement('div');
  row.className = `row${selectedIds.has(note.id) ? ' selected' : ''}`;
  row.dataset.noteId = note.id;
  if (index >= 8) row.style.animation = 'none';

  // Selection circle
  const circle = document.createElement('div');
  circle.className = 'sel-circle';
  circle.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  circle.onclick = (e) => toggleSelect(note.id, e);
  row.appendChild(circle);

  // Icon box
  const iconBox = document.createElement('div');
  iconBox.className = `row-icon-box row-icon-box--${note.type}`;

  // Body
  const body = document.createElement('div');
  body.className = 'row-body';

  const titleEl = document.createElement('div');
  titleEl.className = 'row-title';

  const subEl = document.createElement('div');
  subEl.className = `row-sub row-sub--${note.type}`;

  const timeEl = document.createElement('div');
  timeEl.className = 'row-time-line time-span';
  timeEl.dataset.time = note.time || Date.now();
  timeEl.textContent = getTimeStr(note.time);

  body.appendChild(titleEl);
  body.appendChild(subEl);
  body.appendChild(timeEl);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.onclick = (e) => e.stopPropagation();

  // --- Fill by type ---
  if (note.type === 'link') {
    const href = note.url || toLinkUrl(note.content);
    let domainPath = href.replace(/^https?:\/\//, '');
    if (domainPath.length > 48) domainPath = domainPath.substring(0, 48) + '…';
    titleEl.textContent = linkDisplayName(href);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = domainPath;
    anchor.onclick = (e) => e.stopPropagation();
    subEl.appendChild(anchor);
    iconBox.innerHTML = TYPE_ICONS.link;
    actions.appendChild(mkRowCopyBtn((btn) => doCopy(btn, href)));
    // Whole row (except actions) opens the link
    row.style.cursor = 'pointer';
    row.onclick = (e) => {
      if (e.target.closest('.row-actions, .sel-circle')) return;
      window.open(href, '_blank');
    };

  } else if (note.type === 'code') {
    const full = note.full || note.content;
    titleEl.textContent = note.content;
    let previewLines = full.split('\n').slice(1, 3).join(' ').trim();
    if (activeQuery) {
      const lq = activeQuery.toLowerCase();
      const matchLine = full.split('\n').find((l) => l.toLowerCase().includes(lq));
      if (matchLine) previewLines = matchLine.trim();
    }
    subEl.textContent = previewLines || full.split('\n')[0];
    iconBox.innerHTML = TYPE_ICONS.code;
    actions.appendChild(mkRowCopyBtn((btn) => doCopy(btn, full)));

    // Expandable full code section
    const expand = document.createElement('div');
    expand.className = 'row-expand';
    const pre = document.createElement('pre');
    pre.className = 'code-expand-pre';
    pre.textContent = full;
    expand.appendChild(pre);
    const expandFoot = document.createElement('div');
    expandFoot.className = 'code-expand-foot';
    if (note.lang) {
      const langTag = document.createElement('span');
      langTag.className = 'code-expand-lang';
      langTag.textContent = note.lang;
      expandFoot.appendChild(langTag);
    }
    const expandCopyBtn = mkRowCopyBtn((btn) => doCopy(btn, full));
    expandFoot.appendChild(expandCopyBtn);
    expand.appendChild(expandFoot);
    row.appendChild(expand);

    row.style.cursor = 'pointer';
    row.onclick = (e) => {
      if (e.target.closest('.row-actions, .sel-circle')) return;
      const isOpen = expand.classList.toggle('open');
      subEl.textContent = isOpen ? 'click to collapse' : (previewLines || full.split('\n')[0]);
    };

  } else if (note.type === 'image') {
    const isRenamingImage = renamingNoteId === note.id;
    if (isRenamingImage) {
      titleEl.textContent = '';
      const renameInput = document.createElement('input');
      renameInput.className = 'row-title-input';
      renameInput.value = note.content || '';
      renameInput.setAttribute('data-rename-input', String(note.id));
      renameInput.setAttribute('aria-label', 'Rename image');
      renameInput.onclick = (event) => event.stopPropagation();
      renameInput.onkeydown = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitNoteRename(note.id, renameInput.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelNoteRename();
        }
      };
      renameInput.onblur = () => commitNoteRename(note.id, renameInput.value);
      titleEl.appendChild(renameInput);
    } else {
      titleEl.textContent = note.content;
    }
    const hasImage = note.imageId != null || note.dataUrl || note.imageUrl;
    if (hasImage) {
      const thumb = document.createElement('img');
      thumb.alt = note.content;
      thumb.onerror = () => { if (thumb.isConnected) { thumb.remove(); iconBox.innerHTML = TYPE_ICONS.image; } };
      iconBox.appendChild(thumb);
      getImageObjectUrl(note).then((url) => {
        if (url && thumb.isConnected) thumb.src = url;
        else if (!url && thumb.isConnected) {
          thumb.remove(); iconBox.innerHTML = TYPE_ICONS.image;
          if (!isRenamingImage) subEl.textContent = 'image file unavailable · check images';
        }
      });
    } else {
      iconBox.innerHTML = TYPE_ICONS.image;
    }
    subEl.textContent = isRenamingImage ? 'press enter to save' : (hasImage ? 'click to preview' : 'no preview');
    actions.appendChild(mkRenameIco(note));
    actions.appendChild(mkRowCopyBtn((btn) => copyImage(btn, note)));

    // Expandable full-image section
    const expand = document.createElement('div');
    expand.className = 'row-expand';
    if (hasImage) {
      const imgFull = document.createElement('img');
      imgFull.alt = note.content;
      imgFull.className = 'row-expand-img';
      imgFull.onerror = () => { if (imgFull.isConnected) imgFull.style.display = 'none'; };
      getImageObjectUrl(note).then((url) => { if (url && imgFull.isConnected) imgFull.src = url; });
      expand.appendChild(imgFull);

      const expandFoot = document.createElement('div');
      expandFoot.className = 'row-expand-foot';
      const dlBtn = document.createElement('button');
      dlBtn.className = 'img-dl-btn';
      dlBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:middle"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download`;
      dlBtn.onclick = (e) => { e.stopPropagation(); downloadImage(note); };
      expandFoot.appendChild(dlBtn);
      if (note.imageId != null) expandFoot.appendChild(CacheTrayTransferUI.makeButton(note));
      expand.appendChild(expandFoot);
    }
    row.appendChild(expand);

    row.style.cursor = 'pointer';
    row.onclick = (e) => {
      if (e.target.closest('.row-actions, .sel-circle, .row-title-input')) return;
      const wasOpen = expand.classList.contains('open');
      // Close all other open image expands
      document.querySelectorAll('#feed .row-expand.open').forEach((el) => {
        el.classList.remove('open');
        const sibSub = el.closest('.row')?.querySelector('.row-sub');
        if (sibSub) sibSub.textContent = 'click to preview';
      });
      if (!wasOpen) {
        expand.classList.add('open');
        subEl.textContent = 'click to collapse';
      } else {
        subEl.textContent = 'click to preview';
      }
    };

  } else if (note.type === 'task') {
    titleEl.textContent = note.content;
    if (note.done) titleEl.classList.add('done');
    subEl.textContent = note.done ? 'completed' : '';
    iconBox.innerHTML = note.done ? TYPE_ICONS.task_done : TYPE_ICONS.task;
    iconBox.style.cursor = 'pointer';
    iconBox.onclick = (e) => { e.stopPropagation(); toggleTask(note.id); };
    actions.appendChild(mkRowCopyBtn((btn) => doCopy(btn, note.content)));

  } else {
    // text — adaptive height: short → all visible inline, long → 4-line clamp + tap to expand
    const isLong = note.content.length > 220 || note.content.split('\n').length > 4;

    titleEl.textContent = note.content;
    titleEl.classList.add('row-title--text-body');
    if (isLong) titleEl.style.webkitLineClamp = '4';

    subEl.textContent = isLong ? 'tap to expand' : '';
    if (!isLong) subEl.style.display = 'none';

    iconBox.innerHTML = TYPE_ICONS.text;
    actions.appendChild(mkRowCopyBtn((btn) => doCopy(btn, note.content)));

    if (isLong) {
      let expanded = false;
      row.style.cursor = 'pointer';
      row.onclick = (e) => {
        if (e.target.closest('.row-actions, .sel-circle')) return;
        expanded = !expanded;
        titleEl.style.webkitLineClamp = expanded ? 'none' : '4';
        subEl.textContent = expanded ? 'tap to collapse' : 'tap to expand';
      };
    }
  }

  actions.appendChild(mkFavIco(note));
  actions.appendChild(mkDelIco(note));

  row.appendChild(iconBox);
  row.appendChild(body);
  row.appendChild(actions);
  return row;
}

function parseSearchQuery(raw) {
  const types = ['image', 'code', 'link', 'text', 'task'];
  for (const t of types) {
    const prefix = `#${t}`;
    if (raw.toLowerCase().startsWith(prefix)) {
      return { typeFilter: t, query: raw.slice(prefix.length).trim() };
    }
  }
  return { typeFilter: null, query: raw };
}

function scoreWord(text, word) {
  const idx = text.indexOf(word);
  if (idx < 0) return 0;
  if (idx === 0) return 4;
  if (/[\s\-_/.]/.test(text[idx - 1])) return 3;
  return 2;
}

function scoreNote(note, query) {
  if (!query) return 2;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const fields = [
    note.content || '',
    note.type === 'code' ? (note.full || '') : '',
    note.type === 'link' ? (note.url || '') : '',
  ].map((f) => f.toLowerCase());

  let total = 0;
  for (const word of words) {
    let best = 0;
    for (const f of fields) best = Math.max(best, scoreWord(f, word));
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

let _searchDebounce = null;
function debouncedRenderFeed() {
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(renderFeed, 80);
}

function highlightInElement(el, words) {
  if (!el || !words.length || el.querySelector('input')) return;
  const text = el.textContent;
  if (!text.trim()) return;

  const positions = [];
  const low = text.toLowerCase();
  for (const word of words) {
    let idx = low.indexOf(word);
    while (idx >= 0) {
      positions.push([idx, idx + word.length]);
      idx = low.indexOf(word, idx + 1);
    }
  }
  if (!positions.length) return;

  positions.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of positions) {
    if (merged.length && s <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }

  const frag = document.createDocumentFragment();
  let last = 0;
  for (const [s, e] of merged) {
    frag.appendChild(document.createTextNode(text.slice(last, s)));
    const mark = document.createElement('mark');
    mark.className = 'search-hl';
    mark.textContent = text.slice(s, e);
    frag.appendChild(mark);
    last = e;
  }
  frag.appendChild(document.createTextNode(text.slice(last)));
  el.textContent = '';
  el.appendChild(frag);
}

function openSearch() {
  document.getElementById('searchBar').classList.add('open');
  document.getElementById('searchChips').classList.add('open');
  document.getElementById('searchToggleBtn').classList.add('active');
  document.getElementById('searchInput').focus();
}

function closeSearch() {
  searchQuery = '';
  searchAllWorkspaces = false;
  document.getElementById('searchBar').classList.remove('open', 'has-query');
  document.getElementById('searchChips').classList.remove('open');
  document.getElementById('searchToggleBtn').classList.remove('active');
  document.getElementById('searchAllBtn').classList.remove('active');
  document.getElementById('searchInput').value = '';
  document.getElementById('searchCount').textContent = '';
  document.querySelectorAll('.search-chip.active').forEach((c) => c.classList.remove('active'));
  renderFeed();
}


let _previewNote = null;
function openImageModal(note) {
  getImageObjectUrl(note).then((url) => {
    if (!url) { showToast('Image file unavailable — tap Check images'); return; }
    _previewNote = note;
    document.getElementById('imgPreviewTitle').textContent = note.content || 'Image';
    const img = document.getElementById('imgPreviewImg');
    if (img) img.src = url;
    document.getElementById('imgPreviewModal').classList.add('open');
  });
}

function buildGridCard(note) {
  const card = document.createElement('div');
  card.className = `grid-card${selectedIds.has(note.id) ? ' selected' : ''}`;
  card.dataset.noteId = note.id;

  const circle = document.createElement('div');
  circle.className = `grid-card-circle sel-circle${selectedIds.has(note.id) ? ' checked' : ''}`;
  circle.innerHTML = '<svg viewBox="0 0 24 24" stroke="currentColor"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  circle.onclick = (e) => toggleSelect(note.id, e);
  card.appendChild(circle);

  const thumb = document.createElement('div');
  thumb.className = 'grid-card-thumb';
  const img = document.createElement('img');
  img.alt = note.content;
  img.onerror = () => { if (img.isConnected) img.style.opacity = '0'; };
  getImageObjectUrl(note).then((url) => {
    if (url && img.isConnected) img.src = url;
    else if (!url && img.isConnected) {
      img.remove(); thumb.classList.add('missing'); thumb.textContent = 'Image unavailable';
    }
  });
  thumb.appendChild(img);
  card.appendChild(thumb);

  const foot = document.createElement('div');
  foot.className = 'grid-card-foot';

  const footTop = document.createElement('div');
  footTop.className = 'grid-card-foot-top';
  const title = document.createElement('span');
  title.className = 'grid-card-title';
  title.textContent = note.content;
  footTop.appendChild(title);

  const footActions = document.createElement('div');
  footActions.className = 'grid-card-actions';

  const copyBtn = mkRowCopyBtn((btn) => copyImage(btn, note));
  const favBtn = mkFavIco(note);
  const delBtn = mkDelIco(note);

  footActions.appendChild(copyBtn);
  if (note.imageId != null) footActions.appendChild(CacheTrayTransferUI.makeButton(note));
  footActions.appendChild(favBtn);
  footActions.appendChild(delBtn);
  footTop.appendChild(footActions);
  foot.appendChild(footTop);

  const time = document.createElement('span');
  time.className = 'grid-card-time time-span';
  time.dataset.time = note.time || Date.now();
  time.textContent = getTimeStr(note.time);
  foot.appendChild(time);
  card.appendChild(foot);

  card.onclick = (e) => {
    if (e.target.closest('.grid-card-circle')) return;
    openImageModal(note);
  };

  return card;
}

function renderFeed() {
  const feed = document.getElementById('feed');
  feed.innerHTML = '';

  if (searchQuery) {
    const { typeFilter, query } = parseSearchQuery(searchQuery);

    let pool = searchAllWorkspaces
      ? Object.entries(clusters).flatMap(([ws, c]) => c.notes.map((n) => ({ note: n, ws })))
      : clusters[current].notes.map((n) => ({ note: n, ws: current }));

    if (typeFilter) pool = pool.filter(({ note }) => note.type === typeFilter);

    pool = pool
      .map((item) => ({ ...item, score: scoreNote(item.note, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.note.time - a.note.time);

    document.getElementById('searchCount').textContent = pool.length || '';

    if (!pool.length) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      if (query) {
        empty.innerHTML = `<span class="search-empty-main">No results for "<strong>${query}</strong>"${typeFilter ? ` in ${typeFilter}s` : ''}</span><span class="search-empty-hint">Try fewer words or a different filter</span>`;
      } else {
        empty.innerHTML = `<span class="search-empty-main">No ${typeFilter}s yet</span><span class="search-empty-hint">Copy something to add to your AI prompt</span>`;
      }
      feed.appendChild(empty);
      return;
    }

    const words = query ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];
    pool.forEach(({ note, ws }, index) => {
      const row = buildRow(note, index, query);
      if (searchAllWorkspaces) {
        const badge = document.createElement('div');
        badge.className = 'ws-badge';
        const color = clusters[ws]?.color || '#888';
        badge.innerHTML = `<span class="ws-dot" style="background:${color}"></span>${ws}`;
        row.appendChild(badge);
      }
      feed.appendChild(row);
    });

    if (words.length) {
      feed.querySelectorAll('.row-title, .row-sub').forEach((el) => highlightInElement(el, words));
    }
    return;
  }

  document.getElementById('searchCount').textContent = '';
  const notes = clusters[current].notes.filter((note) =>
    currentCat === 'all' ? true :
    currentCat === 'favorites' ? note.favorited :
    note.type === currentCat
  ).sort((a, b) => (b.favorited ? 1 : 0) - (a.favorited ? 1 : 0));
  if (!notes.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '◦<br>copy anything to stage for AI<br><span style="font-size:11px">screenshots, links, code — send to Claude or ChatGPT instantly</span>';
    feed.appendChild(empty);
    return;
  }
  if (currentCat === 'image' && imageViewMode === 'grid') {
    const grid = document.createElement('div');
    grid.className = 'img-grid';
    notes.forEach((note) => grid.appendChild(buildGridCard(note)));
    feed.appendChild(grid);
    return;
  }
  notes.forEach((note, index) => feed.appendChild(buildRow(note, index)));
}






async function toggleTask(id) {
  const note = clusters[current].notes.find((item) => item.id === id);
  if (!note) return;
  note.done = !note.done;
  await saveData();
  renderCats();
  renderFeed();
}

async function toggleFavorite(id) {
  const note = clusters[current].notes.find((item) => item.id === id);
  if (!note) return;
  note.favorited = !note.favorited;
  await saveData();
  renderCats();
  renderFeed();
}

async function deleteNote(id) {
  const notes = clusters[current].notes;
  const index = notes.findIndex((item) => item.id === id);
  if (index < 0) return;
  lastDel = { note: notes[index], cluster: current, idx: index };
  notes.splice(index, 1);
  await saveData();
  renderCats();
  renderFeed();
  showUndo();
}

function showUndo() {
  const bar = document.getElementById('undoBar');
  const fill = document.getElementById('undoFill');
  bar.classList.add('show');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.style.transition = 'width 5s linear';
      fill.style.width = '0%';
    });
  });
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndo, 5000);
}

function hideUndo() {
  if (lastDel?.note?.imageId != null) imgDbDeleteIfUnreferenced(lastDel.note.imageId).catch(() => {});
  if (lastDel?.note?.id != null) revokeImgCache(lastDel.note.id);
  document.getElementById('undoBar').classList.remove('show');
  lastDel = null;
}

async function undoDelete() {
  if (!lastDel) return;
  clusters[lastDel.cluster].notes.splice(lastDel.idx, 0, lastDel.note);
  lastDel = null;
  clearTimeout(undoTimer);
  await saveData();
  hideUndo();
  renderCats();
  renderFeed();
}

function startRename() {
  const wrap = document.getElementById('clusterNameWrap');
  if (wrap.querySelector('.title-input')) return;
  const span = document.getElementById('clusterTitle');
  const pencil = wrap.querySelector('svg');
  const input = document.createElement('input');
  input.className = 'title-input';
  input.value = current;
  wrap.replaceChild(input, span);
  if (pencil) pencil.style.opacity = '0';
  input.focus();
  input.select();

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const value = input.value.trim().toLowerCase();
    if (value && value !== current && !clusters[value]) {
      clusters[value] = clusters[current];
      delete clusters[current];
      current = value;
    }
    const newSpan = document.createElement('span');
    newSpan.id = 'clusterTitle';
    newSpan.textContent = current;
    if (wrap.contains(input)) wrap.replaceChild(newSpan, input);
    if (pencil) pencil.style.opacity = '';
    await saveData();
    renderAll();
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    }
    if (event.key === 'Escape') {
      input.value = current;
      commit();
    }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('input', () => {
    input.style.width = `${Math.max(80, input.value.length * 15)}px`;
  });
}

function findOrCreateOverflow(baseName, type) {
  return CT.findOrCreateOverflow(clusters, baseName, type);
}

function showToast(message) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.style.opacity = '0';
  }, 2000);
}


function flashFirst() {
  setTimeout(() => {
    const first = document.querySelector('.row');
    if (!first) return;
    first.style.background = 'var(--lime-soft)';
    setTimeout(() => {
      first.style.background = '';
    }, 700);
  }, 40);
}

async function addNote(text, forcedType) {
  const noteType = forcedType === 'task' ? 'task' : (forcedType === 'text' ? 'text' : detectType(text));
  const note = {
    id: ++uid,
    type: noteType,
    content: text,
    time: Date.now()
  };

  if (noteType === 'task') note.done = false;
  if (noteType === 'code') {
    note.full = text;
    note.lang = guessLang(text);
    note.content = text.split('\n')[0] || text;
  }
  if (noteType === 'link') note.url = toLinkUrl(text);

  const existing = clusters[current].notes.filter((item) => item.type === noteType).length;
  if (existing >= CAT_LIMIT) {
    const overflow = findOrCreateOverflow(current, noteType);
    clusters[overflow].notes.unshift(note);
    current = overflow;
    showToast(`moved to ${overflow}`);
  } else {
    clusters[current].notes.unshift(note);
  }

  currentCat = noteType;
  await saveData();
  renderCats();
  renderFeed();
  flashFirst();
}

async function addLinkNote(content, url) {
  const note = {
    id: ++uid,
    type: 'link',
    content,
    url,
    time: Date.now()
  };

  const existing = clusters[current].notes.filter((item) => item.type === 'link').length;
  if (existing >= CAT_LIMIT) {
    const overflow = findOrCreateOverflow(current, 'link');
    clusters[overflow].notes.unshift(note);
    current = overflow;
    showToast(`moved to ${overflow}`);
  } else {
    clusters[current].notes.unshift(note);
  }

  currentCat = 'link';
  await saveData();
  renderAll();
  flashFirst();
}

function smartImageName(filename) {
  if (!filename) return fmtImageTime('Screenshot');
  const base = filename.replace(/\.[^.]+$/, '').trim();
  if (!base || /^(image|img|photo|picture|screenshot|paste|clipboard|untitled|file|\d+)$/i.test(base) || /^image\d*$/i.test(base)) {
    return fmtImageTime('Screenshot');
  }
  return base;
}

function fmtImageTime(prefix) {
  const d = new Date();
  let h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${prefix} · ${h}:${m} ${ampm}`;
}

async function saveImageData() {
  try {
    await saveData();
  } catch (error) {
    console.error('CacheTray image metadata was not saved', error);
    let warning = document.getElementById('imageSaveWarning');
    if (!warning) {
      warning = document.createElement('div');
      warning.id = 'imageSaveWarning';
      warning.setAttribute('role', 'alert');
      warning.style.cssText = 'position:fixed;z-index:9999;inset:8px 8px auto;padding:14px;border:2px solid #f87171;border-radius:12px;background:#292021;color:#fff;font-size:13px;line-height:1.4;box-shadow:0 8px 30px #0009';
      document.body.appendChild(warning);
    }
    warning.textContent = 'Image was NOT saved. Your Mac may be out of disk space. Free space, then copy the image again. Do not clear CacheTray data.';
    throw error;
  }
}

async function addImageNote(file) {
  const rawDataUrl = await blobToDataUrl(file);
  const imageHash = imageComparisonKey(rawDataUrl);

  const allNotes = Object.values(clusters).flatMap((c) => c.notes);
  const duplicate = allNotes.find((n) => {
    if (n.type !== 'image') return false;
    if (n.imageHash) return n.imageHash === imageHash;
    if (n.dataUrl) return imageComparisonKey(n.dataUrl) === imageHash;
    return false;
  });
  if (duplicate) {
    if (duplicate.imageId != null && !await imgDbGetRetry(duplicate.imageId)) {
      try {
        const restored = await compressBlob(file);
        duplicate.imageId = await imgDbStore(restored);
        duplicate.mime = restored.type;
        delete duplicate.dataUrl;
      } catch (error) {
        console.warn('CacheTray: IndexedDB repair failed; retaining inline image', error);
        duplicate.dataUrl = rawDataUrl;
        delete duplicate.imageId;
      }
      duplicate.time = Date.now();
      await saveImageData();
      renderCats(); renderFeed();
      showToast('image restored');
    }
    return;
  }

  let imageId, mime, compressed;
  try {
    compressed = await compressBlob(file);
    imageId = await imgDbStore(compressed);
    mime = compressed.type;
  } catch (error) {
    console.warn('CacheTray: IndexedDB image write failed; retaining inline image', error);
    const dataUrl = rawDataUrl;
    const note = {
      id: ++uid, type: 'image',
      content: smartImageName(file.name),
      dataUrl, imageHash, time: Date.now()
    };
    clusters[current].notes.unshift(note);
    await saveImageData(); renderCats(); renderFeed();
    return;
  }

  const note = {
    id: ++uid,
    type: 'image',
    content: smartImageName(file.name),
    imageId,
    imageHash,
    mime,
    time: Date.now()
  };

  const existing = clusters[current].notes.filter((item) => item.type === 'image').length;
  if (existing >= CAT_LIMIT) {
    const overflow = findOrCreateOverflow(current, 'image');
    clusters[overflow].notes.unshift(note);
    current = overflow;
    showToast(`moved to ${overflow}`);
  } else {
    clusters[current].notes.unshift(note);
  }

  currentCat = 'image';
  await saveImageData();
  renderCats();
  renderFeed();
  flashFirst();
}

function toggleSelect(id, event) {
  if (event) event.stopPropagation();
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  updateSelUI();
  renderCats();
  renderFeed();
}

function updateSelUI() {
  const bar = document.getElementById('selBar');
  const count = document.getElementById('selCount');
  if (selectedIds.size > 0) {
    bar.classList.add('active');
    count.innerHTML = `<span class="sel-n">${selectedIds.size}</span><span class="sel-chk">✓</span>`;
    document.getElementById('bulkInsertBtn').style.display = '';
  } else {
    bar.classList.remove('active');
  }
}

function clearSelect() {
  selectedIds.clear();
  updateSelUI();
  renderCats();
  renderFeed();
}

async function bulkDelete() {
  const ids = Array.from(selectedIds);
  const removedImageIds = [];
  clusters[current].notes.forEach((note) => {
    if (selectedIds.has(note.id)) {
      if (note.imageId != null) removedImageIds.push(note.imageId);
      revokeImgCache(note.id);
    }
  });
  clusters[current].notes = clusters[current].notes.filter((note) => !selectedIds.has(note.id));
  clearSelect();
  await saveData();
  await Promise.allSettled(removedImageIds.map(id => imgDbDeleteIfUnreferenced(id)));
  renderCats();
  renderFeed();
  showToast(`Deleted ${ids.length} items`);
}

function quickAdd(type) {
  const input = document.getElementById('addInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addNote(text, type);
}

async function bulkInsert() {
  const selected = clusters[current].notes.filter((note) => selectedIds.has(note.id));
  if (!selected.length) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { showToast('No active tab'); return; }

  const items = [];
  let failedImages = 0;
  for (const note of selected) {
    if (note.type === 'text' || note.type === 'task') {
      items.push({ kind: 'text', text: note.content, noteType: 'text' });
    } else if (note.type === 'code') {
      items.push({ kind: 'text', text: note.full || note.content, noteType: 'code' });
    } else if (note.type === 'link') {
      items.push({ kind: 'text', text: note.url || note.content, noteType: 'link' });
    } else if (note.type === 'image') {
      try {
        const blob = await getNoteImageBlob(note);
        if (blob) {
          const dataUrl = await blobToDataUrl(blob);
          items.push({ kind: 'image', dataUrl, mime: blob.type || 'image/jpeg' });
        } else {
          failedImages++;
        }
      } catch (_) { failedImages++; }
    }
  }

  if (failedImages > 0 && !items.length) {
    showToast('Could not load images — try again'); return;
  }
  if (failedImages > 0) showToast(`${failedImages} image${failedImages > 1 ? 's' : ''} couldn't load and were skipped`);
  if (!items.length) return;

  // Close popup first so page regains focus before injection — required for
  // focus-sensitive editors like Claude (ProseMirror) that reject paste when unfocused
  if (IS_SIDEBAR) {
    const imageItems = items.filter((i) => i.kind === 'image');
    const textItems = items.filter((i) => i.kind === 'text');
    if (textItems.length) {
      chrome.tabs.sendMessage(tab.id, { type: 'INSERT_ITEMS', items: textItems, fromSidebar: true }).catch(() => {});
    }
    if (imageItems.length) {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: injectImagesFunc,
        args: [imageItems]
      }).catch(() => {});
    }
  } else {
    chrome.tabs.sendMessage(tab.id, { type: 'INSERT_ITEMS', items }).catch(() => {});
    window.close();
  }
  clearSelect();
}

async function bulkShare() {
  const selected = clusters[current].notes.filter((note) => selectedIds.has(note.id));
  if (!selected.length) return;
  if (!navigator.share) { showToast('Sharing not supported on this platform'); return; }

  const images = selected.filter((n) => n.type === 'image');
  const others = selected.filter((n) => n.type !== 'image');

  const files = [];
  for (const note of images) {
    try {
      const blob = await getNoteImageBlob(note, { forcePng: false });
      if (blob) files.push(new File([blob], downloadNameForNote(note), { type: blob.type || 'image/png' }));
    } catch (_) {}
  }

  const textParts = others.map((n) => {
    if (n.type === 'link') return n.url || n.content;
    if (n.type === 'code') return n.full || n.content;
    return n.content || '';
  }).filter(Boolean);

  // Single link only — use url field for cleaner share sheet
  if (!files.length && others.length === 1 && others[0].type === 'link') {
    try {
      await navigator.share({ url: others[0].url || others[0].content });
      clearSelect();
    } catch (err) {
      if (err.name !== 'AbortError') showToast('Share failed');
    }
    return;
  }

  // Try payloads from most complete to least, stopping at first success
  const attempts = [];
  if (files.length && textParts.length) attempts.push({ files, text: textParts.join('\n\n'), _hasFiles: true });
  if (files.length) attempts.push({ files, _hasFiles: true });
  if (textParts.length) attempts.push({ text: textParts.join('\n\n'), _hasFiles: false });

  for (const { _hasFiles, ...payload } of attempts) {
    const supported = !navigator.canShare || navigator.canShare(payload);
    if (!supported) continue;
    try {
      await navigator.share(payload);
      clearSelect();
      if (!_hasFiles && files.length) showToast('Images couldn\'t be shared on this platform');
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }

  showToast('Nothing could be shared on this platform');
}

async function sendToAI(destination) {
  const selected = clusters[current].notes.filter((note) => selectedIds.has(note.id));
  if (!selected.length) return;

  const AI_TARGETS = {
    claude:  { url: 'https://claude.ai/new',  matchUrls: ['*://claude.ai/*'] },
    chatgpt: { url: 'https://chatgpt.com/',   matchUrls: ['*://chatgpt.com/*', '*://chat.openai.com/*'] },
  };
  const target = AI_TARGETS[destination];

  const items = [];
  let failedImages = 0;
  for (const note of selected) {
    if (note.type === 'text' || note.type === 'task') {
      items.push({ kind: 'text', text: note.content, noteType: 'text' });
    } else if (note.type === 'code') {
      items.push({ kind: 'text', text: note.full || note.content, noteType: 'code' });
    } else if (note.type === 'link') {
      items.push({ kind: 'text', text: note.url || note.content, noteType: 'link' });
    } else if (note.type === 'image') {
      try {
        const blob = await getNoteImageBlob(note);
        if (blob) {
          const dataUrl = await blobToDataUrl(blob);
          items.push({ kind: 'image', dataUrl, mime: blob.type || 'image/jpeg' });
        } else failedImages++;
      } catch (_) { failedImages++; }
    }
  }

  if (failedImages > 0 && !items.length) { showToast('Could not load images — try again'); return; }
  if (failedImages > 0) showToast(`${failedImages} image${failedImages > 1 ? 's' : ''} skipped`);
  if (!items.length) return;

  // Prefer the active tab if it matches the target (avoids picking the wrong Claude/GPT
  // tab when multiple are open, and guarantees same-tab case uses the visible tab).
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabs = await chrome.tabs.query({ url: target.matchUrls });
  const existingTab = tabs.find(t => t.id === activeTab?.id) || tabs[0];
  const isSameTab = !!existingTab && existingTab.id === activeTab?.id;

  if (existingTab) {
    const textItems = items.filter((i) => i.kind === 'text');
    const imageItems = items.filter((i) => i.kind === 'image');
    const allItems = [...textItems, ...imageItems];

    if (IS_SIDEBAR) {
      if (isSameTab) {
        // Sidebar + same tab: mirror exactly what bulkInsert does — sendMessage for text,
        // executeScript MAIN world for images (with hasFocus patch).
        if (textItems.length) chrome.tabs.sendMessage(existingTab.id, { type: 'INSERT_ITEMS', items: textItems, fromSidebar: true }).catch(() => {});
        if (imageItems.length) {
          chrome.scripting.executeScript({
            target: { tabId: existingTab.id }, world: 'MAIN',
            func: injectImagesFunc,
            args: [imageItems]
          }).catch(() => {});
        }
      } else {
        // Sidebar + cross tab: switch first, then inject after focus settles
        await chrome.tabs.update(existingTab.id, { active: true });
        await chrome.windows.update(existingTab.windowId, { focused: true });
        setTimeout(() => chrome.tabs.sendMessage(existingTab.id, { type: 'INSERT_ITEMS', items: allItems, fromSidebar: true }).catch(() => {}), 300);
      }
    } else {
      // Popup mode: use INSERT_ITEMS (content-script path) — identical to Insert button.
      // For same-tab use activeTab.id directly (guarantees correct tab, same as bulkInsert).
      // Dispatch BEFORE close/switch — Chrome API calls persist after popup JS context ends.
      const targetId = isSameTab ? activeTab.id : existingTab.id;
      chrome.tabs.sendMessage(targetId, { type: 'INSERT_ITEMS', items: allItems }).catch(() => {});
      if (isSameTab) {
        window.close();
      } else {
        chrome.tabs.update(existingTab.id, { active: true });
      }
    }
    clearSelect();
  } else {
    // No existing tab — store items and open; background.js injects once page loads
    await chrome.storage.session.set({ ct_pending_ai: { items, destination } });
    chrome.tabs.create({ url: target.url });
    if (!IS_SIDEBAR) window.close();
    clearSelect();
  }
}

async function bulkDownload() {
  const selected = clusters[current].notes.filter((note) => selectedIds.has(note.id));
  const images = selected.filter((note) => note.type === 'image');
  if (!images.length) { showToast('No images selected'); return; }

  let count = 0;
  for (const note of images) {
    const source = await getImageObjectUrl(note);
    if (!source) continue;
    if (count > 0) await new Promise((r) => setTimeout(r, 350));
    const link = document.createElement('a');
    link.href = source;
    link.download = downloadNameForNote(note);
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    count++;
  }
  showToast(`Downloaded ${count} image${count > 1 ? 's' : ''} — attach from Downloads`);
}

async function saveCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || /^(chrome|chrome-extension|about|data):/.test(tab.url)) {
    showToast('Cannot save this page');
    return;
  }
  const alreadySaved = clusters[current].notes.some((n) => n.type === 'link' && n.url === tab.url);
  if (alreadySaved) {
    showToast('Already saved');
    return;
  }
  const note = { id: ++uid, type: 'link', content: tab.title || tab.url, url: tab.url, time: Date.now() };
  const existing = clusters[current].notes.filter((n) => n.type === 'link').length;
  if (existing >= CAT_LIMIT) {
    const overflow = findOrCreateOverflow(current, 'link');
    clusters[overflow].notes.unshift(note);
    current = overflow;
  } else {
    clusters[current].notes.unshift(note);
  }
  currentCat = 'link';
  await saveData();
  renderAll();
  flashFirst();
  showToast('Tab saved');
}

// ── Capture toggle ─────────────────────────────────────────────────────────
function updateCaptureUI() {
  const btn = document.getElementById('captureToggleBtn');
  const label = document.getElementById('captureLabel');
  if (captureEnabled) {
    btn.classList.replace('off', 'on') || btn.classList.add('on');
    label.textContent = 'capturing';
    btn.title = 'Auto-capture is ON — click to pause';
  } else {
    btn.classList.replace('on', 'off') || btn.classList.add('off');
    label.textContent = 'paused';
    btn.title = 'Auto-capture is OFF — click to enable';
  }
}

async function toggleCapture() {
  captureEnabled = !captureEnabled;
  await chrome.storage.local.set({ [CAPTURE_KEY]: captureEnabled });
  updateCaptureUI();
  showToast(captureEnabled ? 'Auto-capture on' : 'Auto-capture paused');
}

// ── Theme ──────────────────────────────────────────────────────────────────
function updateThemeButton(theme) {
  const isLight = theme === 'light';
  const btn = document.getElementById('themeToggleBtn');
  if (!btn) return;
  const label = isLight ? 'Switch to dark mode' : 'Switch to light mode';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-pressed', String(isLight));
}

function applyTheme(theme) {
  const normalized = theme === 'light' ? 'light' : 'dark';
  document.documentElement.classList.toggle('light', normalized === 'light');
  try {
    localStorage.setItem(THEME_KEY, normalized);
  } catch (_) {}
  updateThemeButton(normalized);
}

async function initTheme() {
  let localTheme = 'dark';
  try {
    localTheme = localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch (_) {}
  applyTheme(localTheme);

  const data = await chrome.storage.local.get(THEME_KEY);
  applyTheme(data[THEME_KEY] === 'light' ? 'light' : 'dark');
}

async function toggleTheme() {
  const nextTheme = isLightTheme() ? 'dark' : 'light';
  applyTheme(nextTheme);
  await chrome.storage.local.set({ [THEME_KEY]: nextTheme });
  showToast(nextTheme === 'light' ? 'Light mode on' : 'Dark mode on');
}

function bindEvents() {
  document.getElementById('imageHealthBtn')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('image-health.html') });
  });
  document.getElementById('searchToggleBtn').addEventListener('click', () => {
    const bar = document.getElementById('searchBar');
    if (bar.classList.contains('open')) closeSearch();
    else openSearch();
  });
  document.getElementById('searchInput').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    const bar = document.getElementById('searchBar');
    bar.classList.toggle('has-query', !!searchQuery);
    debouncedRenderFeed();
  });
  document.getElementById('searchClear').addEventListener('click', closeSearch);
  document.getElementById('searchAllBtn').addEventListener('click', () => {
    searchAllWorkspaces = !searchAllWorkspaces;
    document.getElementById('searchAllBtn').classList.toggle('active', searchAllWorkspaces);
    renderFeed();
  });
  document.querySelectorAll('.search-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prefix = chip.dataset.prefix;
      const input = document.getElementById('searchInput');
      const wasActive = chip.classList.contains('active');
      document.querySelectorAll('.search-chip').forEach((c) => c.classList.remove('active'));
      if (!wasActive) {
        chip.classList.add('active');
        const rest = searchQuery.replace(/^#\w+\s*/, '');
        input.value = prefix + (rest ? ' ' + rest : '');
      } else {
        input.value = searchQuery.replace(/^#\w+\s*/, '');
      }
      searchQuery = input.value;
      document.getElementById('searchBar').classList.toggle('has-query', !!searchQuery);
      renderFeed();
      input.focus();
    });
  });
  document.getElementById('captureToggleBtn').addEventListener('click', toggleCapture);
  if (!IS_SIDEBAR) {
    document.getElementById('sidebarOpenBtn').addEventListener('click', async () => {
      const win = await chrome.windows.getCurrent();
      chrome.sidePanel.open({ windowId: win.id });
      window.close();
    });
  } else {
    const btn = document.getElementById('sidebarOpenBtn');
    if (btn) btn.remove();
  }
  document.getElementById('clusterNameWrap').addEventListener('click', startRename);
  document.getElementById('noteBtn').addEventListener('click', () => quickAdd('text'));
  document.getElementById('saveTabBtn').addEventListener('click', saveCurrentTab);
  document.getElementById('sendClaudeBtn').addEventListener('click', () => sendToAI('claude'));
  document.getElementById('sendGPTBtn').addEventListener('click', () => sendToAI('chatgpt'));
  document.getElementById('bulkInsertBtn').addEventListener('click', bulkInsert);
  document.getElementById('bulkShareBtn').addEventListener('click', bulkShare);
  document.getElementById('bulkDownloadBtn').addEventListener('click', bulkDownload);
  document.getElementById('bulkDeleteBtn').addEventListener('click', bulkDelete);
  document.getElementById('undoBtn').addEventListener('click', undoDelete);
  document.getElementById('themeToggleBtn')?.addEventListener('click', toggleTheme);

document.getElementById('imgPreviewClose').addEventListener('click', () => {
    document.getElementById('imgPreviewModal').classList.remove('open');
  });
  document.getElementById('imgPreviewModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('imgPreviewModal')) {
      document.getElementById('imgPreviewModal').classList.remove('open');
    }
  });
  document.getElementById('imgPreviewDl').addEventListener('click', () => {
    if (_previewNote) downloadImage(_previewNote);
  });

  document.getElementById('clearAllBtn').addEventListener('click', openClearAllModal);
  document.getElementById('clearAllCancel').addEventListener('click', closeClearAllModal);
  document.getElementById('clearAllConfirm').addEventListener('click', confirmClearAll);
  document.getElementById('clearAllModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('clearAllModal')) closeClearAllModal();
  });


  function updateScrollFade(el) {
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    if (atEnd) {
      el.style.webkitMaskImage = '';
      el.style.maskImage = '';
    } else if (el.classList.contains('overflowing')) {
      el.style.webkitMaskImage = 'linear-gradient(to right, black 0%, black calc(100% - 40px), transparent 100%)';
      el.style.maskImage = 'linear-gradient(to right, black 0%, black calc(100% - 40px), transparent 100%)';
    }
  }
  const clusterTabsEl = document.getElementById('clusterTabs');
  clusterTabsEl.addEventListener('scroll', () => updateScrollFade(clusterTabsEl));

  // Capture phase: when in selection mode, whole row is the click target
  document.getElementById('feed').addEventListener('click', (e) => {
    if (selectedIds.size === 0) return;
    if (e.target.closest('.row-actions') || e.target.closest('.sel-circle')) return;
    const row = e.target.closest('.row');
    if (!row || !row.dataset.noteId) return;
    e.stopPropagation();
    toggleSelect(Number(row.dataset.noteId), e);
  }, true);

  document.addEventListener('click', (e) => {
    if (selectedIds.size === 0) return;
    const path = e.composedPath();
    const selBar = document.getElementById('selBar');
    const catRow = document.getElementById('catRow');
    if (path.includes(selBar) || path.includes(catRow)) return;
    clearSelect();
  });

  document.addEventListener('click', (e) => {
    const bar = document.getElementById('searchBar');
    if (!bar.classList.contains('open')) return;
    const searchArea = [
      bar,
      document.getElementById('searchChips'),
      document.getElementById('searchToggleBtn'),
      document.getElementById('feed'),
    ];
    if (!searchArea.some((el) => el.contains(e.target))) closeSearch();
  });

  document.getElementById('addInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') quickAdd('text');
    if (event.key === 'Escape') document.getElementById('addInput').blur();
  });

  document.getElementById('searchInput').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSearch();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      event.preventDefault();
      openSearch();
    }
  });

  document.addEventListener('paste', async (event) => {
    const input = document.getElementById('addInput');
    // Let pairing codes and other form fields receive normal paste input. The global
    // clipboard capture below is only for pastes made elsewhere in the extension.
    const target = event.target instanceof Element ? event.target : null;
    if (document.activeElement === input || target?.closest('input, textarea, [contenteditable="true"], [role="textbox"]')) return;
    const items = event.clipboardData?.items || [];
    for (let index = 0; index < items.length; index += 1) {
      if (items[index].type.startsWith('image/')) {
        event.preventDefault();
        const file = items[index].getAsFile();
        if (!file) return;
        // addImageNote also repairs an existing image whose IndexedDB Blob is missing.
        await addImageNote(file);
        return;
      }
    }
    const text = event.clipboardData?.getData('text')?.trim();
    if (!text) return;
    event.preventDefault();
    const pasteType = detectType(text);
    const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const pasteKey = pasteType === 'link' ? toLinkUrl(text) : normalize(text);
    const allNotes = Object.values(clusters).flatMap((c) => c.notes);
    const isTextDupe = allNotes.some((n) => {
      if (n.type !== pasteType) return false;
      let noteKey;
      if (n.type === 'link') noteKey = n.url || normalize(n.content);
      else if (n.type === 'code') noteKey = normalize(n.full || n.content);
      else noteKey = normalize(n.content);
      return noteKey === pasteKey;
    });
    if (!isTextDupe) await addNote(text, null);
  });
}

function openClearAllModal() {
  const notes = clusters[current]?.notes || [];
  if (!notes.length) { showToast('nothing to clear'); return; }
  document.getElementById('clearAllClusterName').textContent = current;
  document.getElementById('clearAllModal').classList.add('open');
}

function closeClearAllModal() {
  document.getElementById('clearAllModal').classList.remove('open');
}

async function confirmClearAll() {
  closeClearAllModal();
  const count = clusters[current]?.notes?.length || 0;
  if (!clusters[current]) return;
  const removedImageIds = [];
  clusters[current].notes.forEach((note) => {
    if (note.imageId != null) removedImageIds.push(note.imageId);
    revokeImgCache(note.id);
  });
  clusters[current].notes = [];
  selectedIds.clear();
  currentCat = 'all';
  await saveData();
  await Promise.allSettled(removedImageIds.map(id => imgDbDeleteIfUnreferenced(id)));
  renderAll();
  showToast(`Cleared ${count} item${count !== 1 ? 's' : ''}`);
}

// ── Onboarding ──────────────────────────────────────────────────────────────
const ONBOARD_KEY = 'ct_onboarded_v1';
let onboardIdx = 0;
const ONBOARD_TOTAL = 3;

async function maybeShowOnboarding() {
  const overlay = document.getElementById('onboardOverlay');
  if (!overlay) return;
  const result = await chrome.storage.local.get(ONBOARD_KEY);
  if (result[ONBOARD_KEY]) return;
  overlay.classList.remove('hidden');
}

function onboardNext() {
  const steps = document.querySelectorAll('.onboard-step');
  const dots  = document.querySelectorAll('.onboard-dot');
  steps[onboardIdx].classList.remove('active');
  dots[onboardIdx].classList.remove('active');
  onboardIdx++;
  if (onboardIdx >= ONBOARD_TOTAL) { onboardDone(); return; }
  steps[onboardIdx].classList.add('active');
  dots[onboardIdx].classList.add('active');
  if (onboardIdx === ONBOARD_TOTAL - 1) {
    document.getElementById('onboardNext').textContent = 'Get started →';
  }
}

function onboardDone() {
  const overlay = document.getElementById('onboardOverlay');
  if (!overlay) return;
  overlay.style.opacity = '0';
  overlay.style.transition = 'opacity 0.18s ease';
  setTimeout(() => overlay.classList.add('hidden'), 180);
  chrome.storage.local.set({ [ONBOARD_KEY]: true });
}

document.getElementById('onboardNext')?.addEventListener('click', onboardNext);
document.getElementById('onboardSkip')?.addEventListener('click', onboardDone);

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  bindEvents();
  await initTheme();
  await loadData();
  renderAll();
  const capData = await chrome.storage.local.get(CAPTURE_KEY);
  captureEnabled = capData[CAPTURE_KEY] !== false;
  updateCaptureUI();
  maybeShowOnboarding();
  setInterval(() => {
    document.querySelectorAll('.time-span').forEach((element) => {
      if (element.dataset.time) {
        element.textContent = getTimeStr(Number(element.dataset.time));
      }
    });
  }, 30000);
}

init();
