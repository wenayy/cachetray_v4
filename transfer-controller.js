/* exported CacheTrayTransfer */
(function () {
  'use strict';
  const KEY = 'ct_phone_pairings_v1';
  const base = () => String(globalThis.CACHE_TRAY_TRANSFER_API || '').replace(/\/$/, '');
  function configured() { return base().startsWith('https://') && !base().includes('REPLACE_WITH'); }
  async function api(path, options = {}, token) {
    if (!configured()) throw new Error('Set the transfer API URL in transfer-config.js first');
    const response = await fetch(base() + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Transfer API error (${response.status})`);
    return body;
  }
  async function devices() { return (await chrome.storage.local.get(KEY))[KEY] || []; }
  async function pair(code) {
    const device = await api('/api/devices/pair', { method: 'POST', body: JSON.stringify({ code }) });
    const list = await devices();
    const next = [...list.filter(item => item.receiverDeviceId !== device.receiverDeviceId), device];
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  }
  async function send(imageId, filename, receiverDeviceId) {
    const device = (await devices()).find(item => item.receiverDeviceId === receiverDeviceId);
    if (!device) throw new Error('Phone is not paired');
    const blob = await CT.imgDbGetRetry(imageId);
    if (!(blob instanceof Blob) || !blob.size) throw new Error('Original image Blob is missing from IndexedDB');
    const mimeType = blob.type || 'image/png';
    const start = await api('/api/transfers', {
      method: 'POST', body: JSON.stringify({ receiverDeviceId, filename, mimeType, type: 'image', byteSize: blob.size })
    }, device.senderToken);
    // PUT the exact stored Blob directly to R2. Never mutate or delete the local item.
    const upload = await fetch(start.uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob });
    if (!upload.ok) throw new Error(`R2 upload failed (${upload.status}); check bucket CORS and permissions`);
    await api(`/api/transfers/${encodeURIComponent(start.transferId)}/ready`, { method: 'POST' }, device.senderToken);
    return { transferId: start.transferId, receiverName: device.receiverName };
  }
  globalThis.CacheTrayTransfer = { configured, devices, pair, send };
})();
