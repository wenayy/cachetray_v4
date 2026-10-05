(function () {
  'use strict';
  const KEY = 'cachetray_phone_device_v1';
  const VIEW_KEY = 'cachetray_phone_inbox_view_v1';
  const byId = id => document.getElementById(id);
  const base = String(window.CACHE_TRAY_TRANSFER_API || '').replace(/\/$/, '');
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(navigator.userAgent);
  const phoneName = isIOS ? 'iPhone' : 'Android phone';
  const phonePlatform = isIOS ? 'ios-pwa' : 'android-pwa';
  let device = JSON.parse(localStorage.getItem(KEY) || 'null');
  let pollTimer = null;
  let clipTimer = null;
  let previewItem = null;
  let previewRequest = 0;
  let installPrompt = null;
  let copyResetTimer = null;
  let pollingError = false;
  let toastTimer = null;
  let scanStream = null;
  let scanFrame = null;
  let lastScanAt = 0;
  const imageCache = new Map();
  const imageRequests = new Map();
  const deletedIds = new Set();
  const downloadTokens = new WeakMap();
  const thumbQueue = [];
  let loadingThumbnails = 0;
  let view = localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  let section = 'images';
  let clipFilter = 'all';
  let lastClips = [];
  let pairedMacs = [];
  let pollBusy = false;
  let pairingRevision = 0;
  const CLIP_ICONS = {
    text: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6"/>',
    task: '<path d="m9 11 3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'
  };

  function setSection(next) {
    section = next;
    const showingImages = section === 'images';
    byId('imagesPanel').hidden = !showingImages;
    byId('clipsSection').hidden = showingImages;
    byId('imagesTab').setAttribute('aria-selected', String(showingImages));
    byId('clipsTab').setAttribute('aria-selected', String(!showingImages));
    byId('imagesTab').tabIndex = showingImages ? 0 : -1;
    byId('clipsTab').tabIndex = showingImages ? -1 : 0;
  }
  function setTabCount(id, count) {
    const badge = byId(id);
    badge.hidden = count === 0;
    badge.textContent = count ? String(count) : '';
  }
  function updatePairingStatus(macs) {
    const uniqueMacs = [...new Map(macs.map(mac => [mac.id, mac])).values()];
    const changed = JSON.stringify(uniqueMacs) !== JSON.stringify(pairedMacs);
    pairedMacs = uniqueMacs;
    const active = pairedMacs.filter(mac => mac.online === true);
    const count = active.length;
    const status = byId('pairStatus');
    status.classList.toggle('connected', count > 0);
    status.textContent = count === 1
      ? `Connected to ${active[0].name || 'Mac'} ✓`
      : count > 1 ? 'Connected ✓'
        : pairedMacs.length ? 'Mac paired · offline' : 'No Mac connected';
    byId('scanMacQr').textContent = pairedMacs.length ? 'Add Mac' : 'Scan QR';
    byId('pairToggle').setAttribute('aria-label', pairedMacs.length ? 'Pair another Mac with words' : 'Pair Mac with words');
    byId('manageMacs').hidden = pairedMacs.length === 0;
    if (!pairedMacs.length) {
      byId('connectionsPanel').hidden = true;
      byId('manageMacs').setAttribute('aria-expanded', 'false');
    }
    if (changed) renderConnections();
  }
  function connectionUnavailable(message) {
    const status = byId('pairStatus');
    status.classList.remove('connected');
    status.textContent = message;
  }
  function renderConnections() {
    const container = byId('macConnections');
    container.replaceChildren();
    for (const mac of pairedMacs) {
      const row = document.createElement('div'); row.className = 'mac-connection';
      const label = document.createElement('span');
      label.textContent = `${mac.name || 'Mac'} · ${mac.online ? 'Active' : 'Offline / old pairing'}`;
      const remove = document.createElement('button'); remove.type = 'button';
      remove.className = 'secondary'; remove.textContent = 'Disconnect';
      remove.onclick = async () => {
        if (!confirm(`Disconnect this ${mac.online ? 'Mac' : 'old Mac pairing'}? Images already received and your Mac’s local items stay untouched.`)) return;
        remove.disabled = true;
        try {
          await api(`/api/devices/${encodeURIComponent(device.deviceId)}/pairings/${encodeURIComponent(mac.id)}`, { method: 'DELETE' });
          pairingRevision++;
          updatePairingStatus(pairedMacs.filter(item => item.id !== mac.id));
          notify('Mac disconnected', 'success');
          pollClips();
        } catch (err) { notify(err.message); remove.disabled = false; }
      };
      row.append(label, remove); container.appendChild(row);
    }
  }
  byId('manageMacs').onclick = () => {
    byId('connectionsPanel').hidden = !byId('connectionsPanel').hidden;
    byId('manageMacs').setAttribute('aria-expanded', String(!byId('connectionsPanel').hidden));
  };

  function showError(message) {
    byId('error').textContent = message || '';
    byId('previewError').textContent = byId('preview').hidden ? '' : (message || '');
  }
  function notify(message, tone = 'error') {
    const toast = byId('toast');
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.hidden = false;
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
  }
  function updatePairCode() {
    const valid = Boolean(device?.pairingCode && device.pairingExpiresAt > Date.now());
    byId('pairCode').textContent = valid ? device.pairingCode : 'Code expired. Tap New code.';
    byId('pairInstructions').textContent = valid && /^[A-F0-9]{20}$/.test(device.pairingCode)
      ? 'This is an older code. Tap Generate new code below for an easy three word phrase.'
      : 'Type these three words into the extension’s Send to Phone window. They expire in 10 minutes.';
    byId('copyPairCode').disabled = !valid;
  }
  async function api(path, options = {}) {
    if (!base.startsWith('https://') || base.includes('REPLACE_WITH')) throw new Error('Transfer API is not configured yet');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(base + path, {
        ...options, signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(device ? { Authorization: `Bearer ${device.deviceToken}` } : {}), ...options.headers },
        cache: 'no-store'
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
      return body;
    } finally { clearTimeout(timeout); }
  }
  function applyDevice() {
    byId('deviceName').value = phoneName;
    byId('setup').hidden = Boolean(device);
    byId('inbox').hidden = !device;
    if (device) {
      byId('deviceLabel').textContent = `${device.name} · ${device.deviceId.slice(0, 8)}`;
      updatePairCode();
      startPolling();
    }
  }
  async function connectFromQr(scannedId) {
    const connectId = scannedId || new URLSearchParams(location.hash.slice(1)).get('connect');
    if (!connectId) return;
    if (!scannedId) history.replaceState(null, '', location.pathname + location.search);
    if (!/^[a-f0-9]{64}$/.test(connectId)) { notify('This connection link is invalid.'); return; }
    try {
      if (!device) {
        device = await api('/api/devices/register', { method: 'POST', body: JSON.stringify({ name: phoneName, platform: phonePlatform }) });
        localStorage.setItem(KEY, JSON.stringify(device));
        applyDevice();
      }
      await api('/api/connect/claim', { method: 'POST', body: JSON.stringify({ connectId }) });
      byId('pairBox').hidden = true;
      pairingRevision++;
      connectionUnavailable('Paired · checking Mac…');
      notify('Phone connected! Your recent clips will appear here.', 'success');
      setSection('clips');
      poll(); pollClips();
    } catch (err) { showError(err.message); notify(`Could not connect: ${err.message}`); }
  }
  byId('registerForm').onsubmit = async event => {
    event.preventDefault();
    const button = event.target.querySelector('button'); button.disabled = true; showError('');
    try {
      device = await api('/api/devices/register', { method: 'POST', body: JSON.stringify({ name: byId('deviceName').value, platform: phonePlatform }) });
      localStorage.setItem(KEY, JSON.stringify(device)); applyDevice(); byId('pairBox').hidden = true;
      notify('Phone inbox ready. Tap Scan QR to connect to your Mac.', 'success');
    } catch (err) { showError(err.message); }
    finally { button.disabled = false; }
  };
  byId('pairToggle').onclick = async () => {
    byId('pairBox').hidden = !byId('pairBox').hidden;
    byId('pairToggle').setAttribute('aria-expanded', String(!byId('pairBox').hidden));
    if (!byId('pairBox').hidden && (!device?.pairingCode || device.pairingExpiresAt <= Date.now())) {
      byId('newCode').click();
    }
  };
  function stopScan() {
    if (scanFrame) cancelAnimationFrame(scanFrame);
    scanFrame = null;
    scanStream?.getTracks().forEach(track => track.stop());
    scanStream = null;
    byId('scanVideo').srcObject = null;
    byId('qrScanner').hidden = true;
  }
  function scanConnectId(value) {
    try {
      const url = new URL(value);
      if (url.origin !== location.origin || url.pathname !== '/received.html') return null;
      const id = new URLSearchParams(url.hash.slice(1)).get('connect');
      return /^[a-f0-9]{64}$/.test(id || '') ? id : null;
    } catch (_) { return null; }
  }
  async function startScan() {
    if (!navigator.mediaDevices?.getUserMedia || typeof globalThis.jsQR !== 'function') {
      notify('Camera scanning is unavailable here. Use the three-word pairing option.'); return;
    }
    byId('qrScanner').hidden = false;
    byId('scanStatus').textContent = 'Opening camera…';
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (byId('qrScanner').hidden) { stopScan(); return; }
      const video = byId('scanVideo');
      video.srcObject = scanStream;
      await video.play();
      byId('scanStatus').textContent = 'Point your camera at the QR code on your Mac.';
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const scan = now => {
        if (!scanStream || byId('qrScanner').hidden) return;
        scanFrame = requestAnimationFrame(scan);
        if (now - lastScanAt < 180 || video.readyState < 2) return;
        lastScanAt = now;
        canvas.width = 480;
        canvas.height = Math.max(1, Math.round(video.videoHeight * 480 / Math.max(1, video.videoWidth)));
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const code = globalThis.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
        const id = code && scanConnectId(code.data);
        if (id) { stopScan(); connectFromQr(id); }
      };
      scanFrame = requestAnimationFrame(scan);
    } catch (err) {
      stopScan(); notify('Camera access failed. Allow camera permission or use the three-word pairing option.');
    }
  }
  byId('scanMacQr').onclick = startScan;
  byId('closeScan').onclick = stopScan;
  byId('newCode').onclick = async () => {
    try {
      const result = await api(`/api/devices/${encodeURIComponent(device.deviceId)}/pair-code`, { method: 'POST' });
      device = { ...device, ...result }; localStorage.setItem(KEY, JSON.stringify(device));
      updatePairCode(); showError('');
    } catch (err) { showError(err.message); }
  };
  byId('copyPairCode').onclick = async () => {
    const code = device?.pairingCode;
    if (!code || device.pairingExpiresAt <= Date.now()) return;
    const button = byId('copyPairCode');
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
      else throw new Error('Clipboard API unavailable');
    } catch (_) {
      const field = document.createElement('textarea');
      field.value = code; field.setAttribute('readonly', '');
      field.style.position = 'fixed'; field.style.opacity = '0';
      document.body.appendChild(field); field.select();
      const copied = document.execCommand('copy'); field.remove();
      if (!copied) { showError('Could not copy the code. Select and copy it manually.'); return; }
    }
    clearTimeout(copyResetTimer);
    button.classList.add('copied');
    byId('copyPairCodeLabel').textContent = 'Copied!';
    byId('copyFeedback').textContent = 'Code copied. Switch to CacheTray on your Mac and paste it.';
    byId('copyFeedback').classList.add('visible');
    copyResetTimer = setTimeout(() => {
      if (!button.isConnected) return;
      button.classList.remove('copied');
      byId('copyPairCodeLabel').textContent = 'Copy code';
      byId('copyFeedback').classList.remove('visible');
      byId('copyFeedback').textContent = '';
    }, 2600);
  };
  async function imageUrl(id) {
    const result = await api(`/api/transfers/${encodeURIComponent(id)}/download`);
    return result.downloadUrl;
  }
  async function getImage(item) {
    if (imageCache.has(item.id)) return imageCache.get(item.id);
    if (imageRequests.has(item.id)) return imageRequests.get(item.id);
    const request = (async () => {
      const response = await fetch(await imageUrl(item.id), { cache: 'no-store' });
      if (!response.ok) throw new Error(`Image download failed (${response.status})`);
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) throw new Error('The received file is not an image');
      const image = { blob, url: URL.createObjectURL(blob) };
      imageCache.set(item.id, image);
      return image;
    })();
    imageRequests.set(item.id, request);
    try { return await request; }
    finally { imageRequests.delete(item.id); }
  }
  function releaseImage(id) {
    const image = imageCache.get(id);
    if (image) URL.revokeObjectURL(image.url);
    imageCache.delete(id);
  }
  function updateView() {
    byId('items').className = view === 'grid' ? 'items-grid' : 'items-list';
    byId('items').querySelectorAll('.revealed, .menu-open').forEach(row => {
      row.classList.remove('revealed', 'menu-open');
      row.querySelector('.itemMore')?.setAttribute('aria-expanded', 'false');
    });
    byId('gridView').setAttribute('aria-pressed', String(view === 'grid'));
    byId('listView').setAttribute('aria-pressed', String(view === 'list'));
    byId('viewHint').textContent = view === 'list' ? 'Swipe left on an image to delete it.' : 'Tap the ⋯ on an image to delete it.';
  }
  function closePreview() {
    previewRequest += 1;
    previewItem = null;
    byId('preview').hidden = true;
    byId('previewImage').removeAttribute('src');
    byId('previewLoading').hidden = true;
    byId('previewError').textContent = '';
    byId('sharePreview').disabled = true;
    byId('downloadPreview').disabled = true;
    downloadTokens.set(byId('downloadPreview'), Symbol());
    byId('downloadPreview').textContent = 'Download';
  }
  async function open(item) {
    const request = ++previewRequest;
    previewItem = item;
    byId('preview').hidden = false;
    byId('previewName').textContent = item.filename;
    byId('previewImage').removeAttribute('src');
    byId('previewLoading').hidden = false;
    byId('previewError').textContent = '';
    byId('sharePreview').disabled = true;
    byId('downloadPreview').disabled = true;
    downloadTokens.set(byId('downloadPreview'), Symbol());
    byId('downloadPreview').textContent = 'Download';
    try {
      const image = await getImage(item);
      if (request !== previewRequest) return;
      byId('previewImage').src = image.url;
      byId('sharePreview').disabled = false;
      byId('downloadPreview').disabled = false;
      showError('');
    } catch (err) {
      if (request === previewRequest) { closePreview(); showError(err.message); notify(err.message); }
    } finally {
      if (request === previewRequest) byId('previewLoading').hidden = true;
    }
  }
  async function download(item, button) {
    const token = Symbol();
    downloadTokens.set(button, token);
    button.disabled = true;
    button.textContent = 'Preparing…';
    try {
      const image = await getImage(item);
      const link = document.createElement('a');
      link.href = image.url; link.download = item.filename;
      document.body.appendChild(link); link.click(); link.remove();
      showError('');
      if (downloadTokens.get(button) === token) button.textContent = 'Started ✓';
      notify('Download started. Check your phone’s Downloads if you do not see a prompt.', 'success');
    } catch (err) {
      if (downloadTokens.get(button) === token) button.textContent = 'Try again';
      showError(err.message); notify(err.message);
    } finally {
      setTimeout(() => {
        if (downloadTokens.get(button) !== token) return;
        button.textContent = 'Download';
        button.disabled = button === byId('downloadPreview') && byId('preview').hidden;
      }, 2200);
    }
  }
  function shareFileName(item, mimeType) {
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mimeType] || 'png';
    const stem = String(item.filename || 'CacheTray image').replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9 _-]/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'CacheTray image';
    return `${stem}.${extension}`;
  }
  async function share(item, button) {
    const image = imageCache.get(item.id);
    if (!image) { notify('Image is still loading. Try Share again in a moment.'); return; }
    if (!navigator.share) { notify('This browser cannot share images. Tap Download instead.'); return; }
    let file;
    try {
      const mimeType = image.blob.type || item.mimeType || 'image/png';
      file = new File([image.blob], shareFileName(item, mimeType), { type: mimeType });
      if (navigator.canShare && !navigator.canShare({ files: [file] })) {
        notify('This image type cannot be shared here. Tap Download instead.'); return;
      }
    } catch (err) {
      notify(err.message || 'Could not prepare this image for sharing.'); return;
    }
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Opening…';
    try {
      await navigator.share({ files: [file], title: item.filename });
      showError('');
      notify('Image sent to your chosen app', 'success');
    } catch (err) {
      if (err.name !== 'AbortError') notify(err.message || 'Could not open sharing. Tap Download instead.');
    } finally {
      button.textContent = originalLabel;
      button.disabled = false;
    }
  }
  function loadThumbnail(item, row) {
    thumbQueue.push({ item, row });
    pumpThumbnails();
  }
  function pumpThumbnails() {
    while (loadingThumbnails < 2 && thumbQueue.length) {
      const { item, row } = thumbQueue.shift();
      if (!row.isConnected || row.dataset.id !== item.id) continue;
      loadingThumbnails += 1;
      const image = row.querySelector('.itemThumb');
      const shareButton = row.querySelector('.share-item');
      getImage(item).then(result => {
        if (!row.isConnected) { releaseImage(item.id); return; }
        image.src = result.url;
        image.hidden = false;
        row.classList.add('image-ready');
        shareButton.disabled = false;
        shareButton.textContent = 'Share';
      }).catch(() => {
        if (row.isConnected) { row.classList.add('image-error'); shareButton.textContent = 'Unavailable'; }
      }).finally(() => { loadingThumbnails -= 1; pumpThumbnails(); });
    }
  }
  const thumbnailObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbnailObserver.unobserve(entry.target);
        loadThumbnail(entry.target.itemData, entry.target);
      }
    }, { rootMargin: '240px' }) : null;
  async function deleteReceived(item, row) {
    if (row.classList.contains('deleting')) return;
    row.classList.add('deleting');
    row.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      await api(`/api/transfers/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      deletedIds.add(item.id);
      thumbnailObserver?.unobserve(row);
      row.remove();
      releaseImage(item.id);
      if (previewItem?.id === item.id) closePreview();
      const count = byId('items').children.length;
      setTabCount('imageCount', count);
      byId('status').textContent = count ? `${count} image${count === 1 ? '' : 's'} available for 24 hours` : 'Waiting for images…';
      notify('Removed from this phone and temporary storage. Your Mac image is untouched.', 'success');
    } catch (err) {
      row.classList.remove('deleting');
      row.querySelectorAll('button').forEach(button => { button.disabled = false; });
      if (!row.classList.contains('image-ready')) row.querySelector('.share-item').disabled = true;
      notify(`Could not delete image: ${err.message}`);
    }
  }
  function makeItem(item) {
    const row = document.createElement('article');
    row.className = 'item'; row.dataset.id = item.id; row.itemData = item;
    const swipeDelete = document.createElement('button');
    swipeDelete.type = 'button'; swipeDelete.className = 'itemSwipeDelete'; swipeDelete.textContent = 'Delete';
    swipeDelete.setAttribute('aria-label', `Delete ${item.filename}`);
    swipeDelete.onclick = () => deleteReceived(item, row);
    const content = document.createElement('div'); content.className = 'itemContent';
    const photo = document.createElement('button');
    photo.type = 'button'; photo.className = 'itemPhoto'; photo.setAttribute('aria-label', `Preview ${item.filename}`);
    const image = document.createElement('img'); image.className = 'itemThumb'; image.alt = ''; image.hidden = true;
    const placeholder = document.createElement('span'); placeholder.className = 'itemPlaceholder'; placeholder.textContent = 'Image';
    photo.append(image, placeholder);
    let suppressClickUntil = 0;
    photo.onclick = () => { if (Date.now() >= suppressClickUntil) open(item); };
    const info = document.createElement('div'); info.className = 'itemInfo';
    const name = document.createElement('span'); name.className = 'itemName'; name.textContent = item.filename;
    const meta = document.createElement('span'); meta.className = 'itemMeta';
    meta.textContent = `From ${item.senderName || 'Mac'} · ${new Date(item.createdAt).toLocaleString()}`;
    info.append(name, meta);
    const actions = document.createElement('div'); actions.className = 'itemActions';
    const shareButton = document.createElement('button');
    shareButton.type = 'button'; shareButton.className = 'secondary share-item'; shareButton.textContent = 'Preparing…';
    shareButton.disabled = true; shareButton.title = 'Available when the image preview loads';
    shareButton.onclick = () => share(item, shareButton);
    const downloadButton = document.createElement('button');
    downloadButton.type = 'button'; downloadButton.className = 'secondary'; downloadButton.textContent = 'Download';
    downloadButton.onclick = () => download(item, downloadButton);
    actions.append(shareButton, downloadButton);
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'itemMore'; more.textContent = '⋯';
    more.setAttribute('aria-label', `More options for ${item.filename}`);
    more.setAttribute('aria-expanded', 'false');
    more.onclick = () => {
      const targetClass = view === 'grid' ? 'menu-open' : 'revealed';
      byId('items').querySelectorAll('.revealed, .menu-open').forEach(other => {
        if (other !== row) { other.classList.remove('revealed', 'menu-open'); other.querySelector('.itemMore')?.setAttribute('aria-expanded', 'false'); }
      });
      row.classList.toggle(targetClass);
      more.setAttribute('aria-expanded', String(row.classList.contains(targetClass)));
    };
    const gridDelete = document.createElement('button');
    gridDelete.type = 'button'; gridDelete.className = 'gridDelete'; gridDelete.textContent = 'Delete image';
    gridDelete.setAttribute('aria-label', `Delete ${item.filename}`);
    gridDelete.onclick = () => deleteReceived(item, row);
    content.append(photo, info, actions, more, gridDelete);
    row.append(swipeDelete, content);
    row.addEventListener('click', event => {
      if (Date.now() < suppressClickUntil && content.contains(event.target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    let touchStart = null;
    row.addEventListener('touchstart', event => {
      if (view !== 'list' || event.touches.length !== 1) return;
      touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }, { passive: true });
    row.addEventListener('touchend', event => {
      if (view !== 'list' || !touchStart) return;
      const dx = event.changedTouches[0].clientX - touchStart.x;
      const dy = event.changedTouches[0].clientY - touchStart.y;
      touchStart = null;
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      suppressClickUntil = Date.now() + 400;
      if (dx < 0) {
        byId('items').querySelectorAll('.revealed').forEach(other => { if (other !== row) other.classList.remove('revealed'); });
        row.classList.add('revealed');
      } else row.classList.remove('revealed');
      more.setAttribute('aria-expanded', String(row.classList.contains('revealed')));
    }, { passive: true });
    return row;
  }
  function render(items) {
    items = items.filter(item => !deletedIds.has(item.id));
    const container = byId('items');
    const ids = new Set(items.map(item => item.id));
    for (const child of [...container.children]) {
      if (ids.has(child.dataset.id)) continue;
      thumbnailObserver?.unobserve(child);
      child.remove();
      releaseImage(child.dataset.id);
    }
    const rows = new Map([...container.children].map(row => [row.dataset.id, row]));
    for (const [index, item] of items.entries()) {
      const existing = rows.get(item.id);
      const row = existing || makeItem(item);
      if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
      if (!existing) {
        if (thumbnailObserver) thumbnailObserver.observe(row);
        else loadThumbnail(item, row);
      }
    }
    byId('status').textContent = items.length ? `${items.length} image${items.length === 1 ? '' : 's'} available for 24 hours` : 'Waiting for images…';
    setTabCount('imageCount', items.length);
  }
  async function shareClip(item) {
    const text = item.type === 'link' ? safeLinkUrl(item) : (item.full || item.content || '');
    if (item.type === 'link' && !text) { notify('This clip is not a valid web link. Use Copy instead.'); return; }
    if (!navigator.share) {
      notify('Sharing is unavailable in this browser. Use Copy instead.');
      return;
    }
    try {
      await navigator.share(item.type === 'link'
        ? { title: item.content || 'CacheTray link', url: text }
        : { title: 'CacheTray clip', text });
    } catch (err) {
      if (err.name !== 'AbortError') notify('Could not share this clip. Use Copy instead.');
    }
  }
  function safeLinkUrl(item) {
    const raw = String(item.url || item.content || '').trim();
    try {
      const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch (_) { return null; }
  }
  const clipActionIcon = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  function renderClips(items) {
    lastClips = items;
    const container = byId('clips');
    container.replaceChildren();
    setTabCount('clipCount', items.length);
    const visible = clipFilter === 'all' ? items : items.filter(item => item.type === clipFilter);
    if (!visible.length) {
      const empty = document.createElement('p'); empty.className = 'clips-empty';
      empty.textContent = items.length ? `No ${clipFilter === 'link' ? 'links' : clipFilter + ' clips'} yet.` : 'No recent clips yet. Copy something on your Mac.';
      container.appendChild(empty); return;
    }
    for (const item of visible) {
      const clipType = Object.hasOwn(CLIP_ICONS, item.type) ? item.type : 'text';
      const card = document.createElement('article'); card.className = `clip-card clip-${clipType}`;
      const icon = document.createElement('span'); icon.className = 'clip-icon'; icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${CLIP_ICONS[clipType]}</svg>`;
      const body = document.createElement('div'); body.className = 'clip-text';
      const type = document.createElement('span'); type.className = 'clip-type';
      type.textContent = `${item.type} · ${item.senderName || 'Mac'}`;
      const content = document.createElement('span');
      content.textContent = item.full || item.content || item.url || '(empty clip)';
      body.append(type, content);
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = `secondary ${clipType === 'link' ? 'clip-action-icon' : ''}`;
      const copyIcon = clipActionIcon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3"/>');
      if (clipType === 'link') { copy.innerHTML = copyIcon; copy.title = 'Copy link'; copy.setAttribute('aria-label', 'Copy link'); }
      else copy.textContent = 'Copy';
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(item.type === 'link' ? (item.url || item.content) : (item.full || item.content || ''));
          copy.textContent = '✓'; notify('Copied to clipboard', 'success');
          setTimeout(() => { if (copy.isConnected) { if (clipType === 'link') copy.innerHTML = copyIcon; else copy.textContent = 'Copy'; } }, 1800);
        } catch (_) { notify('Could not copy this clip. Try selecting its text.'); }
      };
      const shareButton = document.createElement('button');
      shareButton.type = 'button'; shareButton.className = 'secondary clip-share';
      shareButton.title = 'Share clip'; shareButton.setAttribute('aria-label', `Share ${item.type} clip`);
      shareButton.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="19" r="2"/><path d="m8 11 8-5M8 13l8 5"/></svg>';
      shareButton.onclick = () => shareClip(item);
      const actions = document.createElement('div'); actions.className = 'clip-actions';
      actions.append(copy, shareButton);
      if (clipType === 'link') {
        shareButton.classList.add('clip-action-icon');
        const href = safeLinkUrl(item);
        if (href) {
          const openLink = document.createElement('a');
          openLink.className = 'secondary clip-action-icon'; openLink.href = href;
          openLink.target = '_blank'; openLink.rel = 'noopener noreferrer';
          openLink.title = 'Open link'; openLink.setAttribute('aria-label', 'Open link in browser');
          openLink.innerHTML = clipActionIcon('<path d="M14 3h7v7M21 3l-9 9"/><path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/>');
          actions.append(openLink);
        }
      }
      card.append(icon, body, actions); container.appendChild(card);
    }
  }
  async function pollClips() {
    if (!device || document.hidden || !navigator.onLine) return;
    try {
      const result = await api(`/api/devices/${encodeURIComponent(device.deviceId)}/clips`);
      renderClips(result.items || []);
      const notice = byId('phonePlanNotice');
      notice.hidden = !result.plans?.length;
      if (result.plans?.length) {
        const free = result.plans.some(plan => plan.plan !== 'pro');
        notice.textContent = free
          ? 'Free sync · newest 20 clips per category from each Free Mac. Upgrade on your computer for more.'
          : `Pro sync · newest ${result.plans[0].clipsPerCategory} clips per category.`;
      }
      // Pairing status comes from the faster image-inbox poll, not a potentially stale clip response.
    } catch (err) { showError(err.message); }
  }
  async function poll() {
    if (!device || document.hidden || !navigator.onLine || pollBusy) return;
    pollBusy = true;
    const revision = pairingRevision;
    try {
      const result = await api(`/api/devices/${encodeURIComponent(device.deviceId)}/transfers`);
      render(result.transfers || []);
      if (revision === pairingRevision && Array.isArray(result.pairedMacs)) updatePairingStatus(result.pairedMacs);
      if (!navigator.onLine) connectionUnavailable('Phone offline · reconnect to check Mac');
      if (pollingError) { showError(''); pollingError = false; }
    } catch (err) {
      pollingError = true; showError(err.message);
      connectionUnavailable('Connection unavailable · retrying…');
    } finally { pollBusy = false; }
  }
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (clipTimer) clearInterval(clipTimer);
    poll(); pollClips();
    pollTimer = setInterval(poll, 2500);
    clipTimer = setInterval(pollClips, 15000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopScan();
    else { connectionUnavailable(navigator.onLine ? 'Checking connection…' : 'Phone offline · reconnect to check Mac'); poll(); pollClips(); }
  });
  window.addEventListener('online', () => { poll(); pollClips(); });
  window.addEventListener('offline', () => { connectionUnavailable('Phone offline · reconnect to check Mac'); });
  byId('closePreview').onclick = closePreview;
  byId('preview').addEventListener('click', event => { if (event.target === byId('preview')) closePreview(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !byId('preview').hidden) closePreview(); });
  byId('sharePreview').onclick = () => { if (previewItem) share(previewItem, byId('sharePreview')); };
  byId('downloadPreview').onclick = () => { if (previewItem) download(previewItem, byId('downloadPreview')); };
  byId('gridView').onclick = () => { view = 'grid'; localStorage.setItem(VIEW_KEY, view); updateView(); };
  byId('listView').onclick = () => { view = 'list'; localStorage.setItem(VIEW_KEY, view); updateView(); };
  byId('imagesTab').onclick = () => setSection('images');
  byId('clipsTab').onclick = () => setSection('clips');
  byId('clipFilters').addEventListener('click', event => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    clipFilter = button.dataset.filter;
    byId('clipFilters').querySelectorAll('button').forEach(option => {
      option.setAttribute('aria-pressed', String(option === button));
    });
    renderClips(lastClips);
  });
  byId('imagesTab').onkeydown = byId('clipsTab').onkeydown = event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = section === 'images' ? 'clips' : 'images';
    setSection(next); byId(next === 'images' ? 'imagesTab' : 'clipsTab').focus();
  };
  const installed = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const showInstallButton = () => { byId('installApp').hidden = installed() || !(isAndroid || isIOS); };
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); installPrompt = event; showInstallButton();
  });
  function showInstallGuide() {
    byId('installInstructions').textContent = (isIOS
      ? 'On iPhone, open this page in Safari. Tap Share, then Add to Home Screen. Turn on Open as Web App if shown, then tap Add.'
      : 'In Chrome on Android, open the ⋮ menu and choose Install app or Add to Home screen.')
      + ' Then open CacheTray from your home screen, tap Scan QR (or Add Mac), and scan step 2 in your computer extension.';
    byId('installGuide').hidden = false;
  }
  byId('installApp').onclick = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null; showInstallButton(); return;
    }
    showInstallGuide();
  };
  byId('closeInstallGuide').onclick = () => { byId('installGuide').hidden = true; };
  window.addEventListener('appinstalled', () => { installPrompt = null; showInstallButton(); byId('installGuide').hidden = true; });
  showInstallButton();
  if (location.hash === '#install' && !installed() && (isAndroid || isIOS)) showInstallGuide();
  updateView();
  setSection('images');
  applyDevice();
  connectFromQr();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js?v=16').catch(() => {});
})();
