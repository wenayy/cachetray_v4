/* exported CacheTrayTransferUI */
(function () {
  'use strict';
  let devices = [];
  let configured = false;
  let pending = null;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'phoneTransferModal';
  modal.innerHTML = `<div class="modal phone-transfer-modal" role="dialog" aria-modal="true" aria-label="Send to phone">
    <div class="modal-title">Send to Phone</div>
    <div class="modal-sub">Pair your Android CacheTray PWA once, then send individual images.</div>
    <div id="phoneTransferDevices"></div>
    <label class="phone-pair-label" for="phonePairCode">Pairing code from the phone</label>
    <input id="phonePairCode" class="phone-pair-input" maxlength="80" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="e.g. river cloud apple">
    <div id="phoneTransferError" class="phone-transfer-error" role="alert"></div>
    <div class="modal-actions"><button type="button" class="modal-btn cancel" id="phoneTransferClose">Close</button>
    <button type="button" class="modal-btn cloud-primary" id="phonePairBtn">Pair phone</button></div>
  </div>`;
  document.body.appendChild(modal);
  const byId = id => document.getElementById(id);
  function error(message) { byId('phoneTransferError').textContent = message || ''; }
  function close() { modal.classList.remove('open'); pending = null; error(''); }
  byId('phoneTransferClose').onclick = close;
  modal.onclick = event => { if (event.target === modal) close(); };
  async function call(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || 'Transfer failed');
    return response;
  }
  async function refresh() {
    const result = await call({ type: 'TRANSFER_DEVICES' });
    devices = result.devices || [];
    configured = result.configured;
    const container = byId('phoneTransferDevices');
    container.replaceChildren();
    byId('phonePairCode').previousElementSibling.textContent = devices.length
      ? 'Pair another phone (optional)'
      : 'Three word phrase from your phone';
    if (!configured) error('The transfer API is not configured yet. See SEND_TO_PHONE_SETUP.md.');
    for (const device of devices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'phone-device-choice';
      button.textContent = `📱 Send to ${device.receiverName || 'Phone'}`;
      button.onclick = () => { const item = pending; close(); if (item) send(item.note, item.button, device); };
      container.appendChild(button);
    }
  }
  async function send(note, button, device) {
    button.disabled = true;
    button.textContent = 'Uploading…';
    try {
      await call({ type: 'TRANSFER_SEND_IMAGE', imageId: note.imageId,
        filename: downloadNameForNote(note), receiverDeviceId: device.receiverDeviceId });
      button.textContent = 'Sent ✓';
      setTimeout(() => { if (button.isConnected) { button.textContent = '📱 Send to Phone'; button.disabled = false; } }, 3000);
    } catch (err) {
      button.textContent = 'Retry send';
      button.title = err.message;
      button.disabled = false;
      pending = { note, button };
      modal.classList.add('open');
      try { await refresh(); } catch (_) { /* Keep the upload error visible. */ }
      error(err.message);
      (byId('phoneTransferDevices').querySelector('button') || byId('phonePairCode')).focus();
    }
  }
  function makeButton(note) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'img-dl-btn phone-send-btn';
    button.textContent = '📱 Send to Phone';
    button.title = 'Upload only this image temporarily to your paired phone';
    button.onclick = async event => {
      event.stopPropagation();
      try {
        await refresh();
        if (devices.length === 1 && configured) await send(note, button, devices[0]);
        else { pending = { note, button }; modal.classList.add('open'); byId('phonePairCode').focus(); }
      } catch (err) { pending = { note, button }; modal.classList.add('open'); byId('phonePairCode').focus(); error(err.message); }
    };
    return button;
  }
  byId('phonePairBtn').onclick = async () => {
    const button = byId('phonePairBtn');
    button.disabled = true;
    error('');
    try {
      await call({ type: 'TRANSFER_PAIR', code: byId('phonePairCode').value });
      byId('phonePairCode').value = '';
      await refresh();
      const item = pending;
      const pairedDevice = devices[devices.length - 1];
      close();
      if (item && pairedDevice) await send(item.note, item.button, pairedDevice);
    }
    catch (err) { error(err.message); }
    finally { button.disabled = false; }
  };
  globalThis.CacheTrayTransferUI = { makeButton };
})();
