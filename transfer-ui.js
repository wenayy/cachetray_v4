/* exported CacheTrayTransferUI */
(function () {
  'use strict';
  let devices = [];
  let configured = false;
  let pending = null;
  let connectTimer = null;
  let refreshInFlight = null;
  let refreshSignature = null;
  let installationReady = false;
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'phoneTransferModal';
  modal.innerHTML = `<div class="modal phone-transfer-modal" role="dialog" aria-modal="true" aria-label="Phone connection">
    <div class="phone-modal-header"><div class="modal-title" id="phoneTransferTitle">Connect your phone</div><button type="button" class="modal-btn cancel" id="phoneTransferClose">Close</button></div>
    <div class="phone-modal-body">
    <div class="modal-sub" id="phoneTransferSummary">Scan once to see recent clips on your phone. Connecting uploads your text, links, code, and tasks to temporary cloud storage for 24 hours. Images are sent individually.</div>
    <div class="phone-plan-row"><span id="phonePlanUsage">Free · 5 image sends/day · 20 clips/category</span><button id="phoneUpgrade" type="button" class="modal-btn">Upgrade</button></div>
    <div id="phoneTransferDevices"></div>
    <div id="phoneInstallStep" class="phone-install-guide"><p><strong>1 · Install on your phone</strong></p><small>Scan this QR with your phone camera. It opens CacheTray on your phone with installation instructions.</small><div class="phone-qr-area"><div id="phoneInstallQr"></div><p>Install QR · opens the website, does not pair devices</p></div><button type="button" id="phoneInstallNext" class="modal-btn cloud-primary">App installed? Connect phone →</button><button type="button" id="phoneInstallSkip" class="phone-install-link phone-step-back">Already have the app? Skip this step →</button></div>
    <div class="phone-qr-actions"><button type="button" class="modal-btn cloud-primary" id="phoneStartQr">Show QR code</button></div>
    <div id="phoneConnectStep" hidden><p class="phone-step-title"><strong>2 · Connect your phone</strong></p><p class="modal-sub">Open CacheTray on your phone, tap Scan QR (or Add Mac), then scan the connection QR below.</p>
    <div id="phoneQrArea" class="phone-qr-area hidden"><div id="phoneQrCode"></div><p id="phoneQrStatus">Scan with your phone camera to pair. You can then install CacheTray from your phone browser.</p></div>
    <details class="phone-manual-pair" id="phoneManualPair"><summary>Use a pairing phrase instead</summary>
    <label class="phone-pair-label" for="phonePairCode">Pairing code from the phone</label>
    <input id="phonePairCode" class="phone-pair-input" maxlength="80" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="e.g. river cloud apple">
    <button type="button" class="modal-btn" id="phonePairBtn">Pair with phrase</button></details>
    <button type="button" id="phoneInstallBack" class="phone-install-link phone-step-back">← Back to install QR</button></div>
    <div id="phoneTransferError" class="phone-transfer-error" role="alert"></div>
    <div id="phoneImageLimit" class="phone-image-limit" role="alert" hidden><strong>Phone image limit reached</strong><p id="phoneImageLimitMessage"></p><button type="button" id="phoneImageLimitUpgrade" class="modal-btn cloud-primary">Go Pro · $4.99/month</button></div>
    </div>
  </div>`;
  document.body.appendChild(modal);
  const byId = id => document.getElementById(id);
  function error(message) { byId('phoneTransferError').textContent = message || ''; byId('phoneImageLimit').hidden = true; }
  function close() {
    modal.classList.remove('open'); pending = null; error('');
    clearInterval(connectTimer); connectTimer = null;
    byId('phoneQrArea').classList.add('hidden');
  }
  byId('phoneTransferClose').onclick = close;
  modal.onclick = event => { if (event.target === modal) close(); };
  async function call(message) {
    let timer;
    const response = await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message.type === 'TRANSFER_SEND_IMAGE'
        ? 'The send did not finish in time. Check the phone inbox before retrying; the image may already have arrived.'
        : 'The extension did not respond. Reload CacheTray and try again.')), message.type === 'TRANSFER_SEND_IMAGE' ? 120000 : 20000); })
    ]).finally(() => clearTimeout(timer));
    if (!response?.ok) {
      const failure = new Error(response?.error || 'Transfer failed');
      failure.code = response?.code;
      failure.limits = response?.limits;
      throw failure;
    }
    return response;
  }
  function refresh() {
    if (!refreshInFlight) refreshInFlight = refreshState().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }
  async function refreshState() {
    const result = await call({ type: 'TRANSFER_DEVICES' });
    devices = result.devices || [];
    configured = result.configured;
    const account = result.account || { plan: 'free', maxPhones: 1, pairedPhones: devices.length };
    const paired = devices.length > 0;
    const connected = paired && Boolean(result.account) && devices.some(device => device.enabled !== false && Number(device.lastSeenAt) > Date.now() - 120000);
    const signature = JSON.stringify({ configured, verified: Boolean(result.account), pending: Boolean(pending),
      plan: account.plan, maxPhones: account.maxPhones, pairedPhones: account.pairedPhones,
      usage: account.usage, limits: account.limits, billing: account.billing,
      devices: devices.map(device => [device.receiverDeviceId, device.receiverName, Number(device.lastSeenAt) > Date.now() - 120000]) });
    // Heartbeats must not reset a phrase field or replace a focused Disconnect button.
    if (signature === refreshSignature) return;
    refreshSignature = signature;
    byId('phonePlanUsage').textContent = account.plan === 'pro'
      ? `Pro · ${account.limits?.imagesPerPhone || 50} images/phone · ${account.limits?.clipsPerCategory || 100} clips/category`
      : `Free · 5 image sends/day · ${account.usage?.imagesSentLast24h || 0}/5 sent in the last 24 hours · 20 clips/category`;
    byId('phoneUpgrade').textContent = account.plan === 'pro' ? 'Manage' : 'Upgrade';
    const trigger = byId('phoneConnectBtn');
    const names = devices.map(device => device.receiverName || 'Phone');
    trigger?.classList.toggle('active', paired);
    trigger?.classList.toggle('phone-connected', connected);
    if (trigger) {
      trigger.title = paired ? `${connected ? 'Connected to' : 'Paired with'} ${names.join(', ')}` : 'Connect phone';
      trigger.setAttribute('aria-label', trigger.title);
      trigger.dataset.tooltip = paired ? (connected ? 'Connected' : 'Paired') : 'Phone';
    }
    byId('phoneTransferTitle').textContent = paired
      ? (devices.length === 1 ? `${connected ? 'Connected to' : 'Paired with'} ${names[0]}${connected ? ' ✓' : ''}` : `${devices.length} phones paired`)
      : 'Connect your phone';
    byId('phoneTransferSummary').textContent = paired
      ? 'Recent clips sync to your paired phone. Send images individually.'
      : 'Scan once to see recent clips on your phone. Connecting uploads your text, links, code, and tasks to temporary cloud storage for 24 hours. Images are sent individually.';
    const addPhone = byId('phoneStartQr');
    addPhone.textContent = paired ? 'Add another phone' : 'Show QR code';
    const atLimit = paired && account.pairedPhones >= account.maxPhones;
    byId('phoneInstallStep').hidden = paired || installationReady;
    addPhone.hidden = atLimit || (!paired && !installationReady);
    if (atLimit) { byId('phoneConnectStep').hidden = true; byId('phoneQrArea').classList.add('hidden'); }
    byId('phoneManualPair').hidden = atLimit;
    addPhone.classList.toggle('cloud-primary', !paired);
    addPhone.classList.toggle('cancel', paired);
    byId('phoneManualPair').open = false;
    const container = byId('phoneTransferDevices');
    container.replaceChildren();
    if (!configured) error('The transfer API is not configured yet. See SEND_TO_PHONE_SETUP.md.');
    else if (!result.account && paired) error('Connection unavailable. Your saved phone pairing is kept; try again when online.');
    else if (atLimit) error(`${account.plan === 'pro' ? 'Pro' : 'Free'} allows ${account.maxPhones} paired phone${account.maxPhones === 1 ? '' : 's'}. ${account.plan === 'free' ? 'Upgrade to Pro for a second phone, or disconnect this one.' : 'Disconnect one to add another.'}`);
    for (const device of devices) {
      const row = document.createElement('div'); row.className = 'phone-device-row';
      const label = document.createElement(pending ? 'button' : 'span');
      label.className = 'phone-device-choice';
      label.textContent = pending
        ? `📱 Send to ${device.receiverName || 'Phone'}`
        : `📱 ${device.receiverName || 'Phone'} · ${result.account && Number(device.lastSeenAt) > Date.now() - 120000 ? 'connected' : 'paired'}`;
      if (device.enabled === false) {
        label.textContent = `📱 ${device.receiverName || 'Phone'} · paused (Free limit)`;
        if (pending) label.disabled = true;
      }
      if (pending) {
        label.type = 'button';
        label.onclick = () => { const item = pending; close(); if (item) send(item.note, item.button, device); };
      }
      const disconnect = document.createElement('button');
      disconnect.type = 'button'; disconnect.className = 'phone-disconnect'; disconnect.textContent = 'Disconnect';
      disconnect.setAttribute('aria-label', `Disconnect ${device.receiverName || 'phone'}`);
      disconnect.onclick = async () => {
        if (!confirm(`Disconnect ${device.receiverName || 'this phone'}? New clips will stop syncing.`)) return;
        disconnect.disabled = true;
        try { await call({ type: 'TRANSFER_DISCONNECT', receiverDeviceId: device.receiverDeviceId }); await refresh(); }
        catch (err) { error(err.message); disconnect.disabled = false; }
      };
      row.append(label, disconnect); container.appendChild(row);
    }
  }
  function displayQr(session) {
    installationReady = true;
    byId('phoneInstallStep').hidden = true;
    byId('phoneConnectStep').hidden = false;
    clearInterval(connectTimer);
    const qr = globalThis.CacheTrayQr(0, 'M');
    qr.addData(session.connectUrl); qr.make();
    byId('phoneQrCode').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 12, scalable: true });
    byId('phoneQrArea').classList.remove('hidden');
    byId('phoneQrStatus').textContent = 'Connection QR · scan inside the phone app. Expires in 10 minutes.';
    byId('phoneStartQr').textContent = 'New QR code';
    let checking = false;
    connectTimer = setInterval(async () => {
        if (checking || !modal.classList.contains('open')) return;
        checking = true;
        try {
          const { result } = await call({ type: 'TRANSFER_CONNECT_STATUS', session });
          if (result.expired) { clearInterval(connectTimer); byId('phoneQrStatus').textContent = 'Code expired. Tap New QR code.'; }
          if (result.connected) {
            clearInterval(connectTimer); connectTimer = null;
            byId('phoneQrArea').classList.add('hidden');
            byId('phoneConnectStep').hidden = true;
            await refresh();
            const item = pending;
            const pairedDevice = devices.find(device => device.receiverDeviceId === result.receiverDeviceId);
            if (item && pairedDevice) { close(); await send(item.note, item.button, pairedDevice); }
          }
        } catch (err) { error(err.message); }
        finally { checking = false; }
    }, 2000);
  }
  async function showQr() {
    const button = byId('phoneStartQr');
    button.disabled = true; button.textContent = 'Creating…'; error('');
    try {
      const { session } = await call({ type: 'TRANSFER_CONNECT_START' });
      displayQr(session);
    } catch (err) { error(err.message); button.textContent = 'Show QR code'; }
    finally { button.disabled = false; }
  }
  async function showPendingQrOrStart() {
    const { session } = await call({ type: 'TRANSFER_CONNECT_PENDING' });
    if (session) displayQr(session);
    else await showQr();
  }
  byId('phoneStartQr').onclick = showQr;
  function showInstall() {
    installationReady = false;
    clearInterval(connectTimer); connectTimer = null;
    byId('phoneConnectStep').hidden = true;
    byId('phoneQrArea').classList.add('hidden');
    byId('phoneInstallStep').hidden = devices.length > 0;
    if (!devices.length) {
      byId('phoneStartQr').hidden = true;
      const qr = globalThis.CacheTrayQr(0, 'M');
      qr.addData('https://cachetray.gitflex.lol/received.html#install'); qr.make();
      byId('phoneInstallQr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 12, scalable: true });
    }
  }
  byId('phoneInstallNext').onclick = async () => {
    installationReady = true;
    byId('phoneInstallStep').hidden = true;
    byId('phoneConnectStep').hidden = false;
    byId('phoneStartQr').hidden = false;
    try { await showPendingQrOrStart(); } catch (err) { error(err.message); }
  };
  byId('phoneInstallBack').onclick = showInstall;
  byId('phoneInstallSkip').onclick = byId('phoneInstallNext').onclick;
  byId('phoneUpgrade').onclick = () => { close(); globalThis.CacheTrayBillingUI?.open(); };
  byId('phoneImageLimitUpgrade').onclick = () => { close(); globalThis.CacheTrayBillingUI?.open(); };
  byId('phoneConnectBtn')?.addEventListener('click', async () => {
    pending = null; modal.classList.add('open');
    try { await refresh(); showInstall(); }
    catch (err) { error(err.message); }
  });
  async function send(note, button, device) {
    button.disabled = true;
    button.textContent = 'Uploading…';
    try {
      await call({ type: 'TRANSFER_SEND_IMAGE', imageId: note.imageId,
        filename: downloadNameForNote(note), receiverDeviceId: device.receiverDeviceId });
      button.textContent = 'Sent ✓';
      button.classList.add('phone-already-sent');
      button.title = `Already sent to ${device.receiverName || 'your phone'}. Click to send again. Cloud copies expire after 24 hours.`;
      setTimeout(() => { if (button.isConnected) { button.textContent = '✓ Sent · Send again'; button.disabled = false; } }, 2000);
    } catch (err) {
      button.textContent = 'Retry send';
      button.title = err.message;
      button.disabled = false;
      pending = { note, button };
      modal.classList.add('open');
      error(err.message);
      if (err.code === 'IMAGE_LIMIT' || err.code === 'DAILY_IMAGE_LIMIT') {
        const daily = err.code === 'DAILY_IMAGE_LIMIT';
        const free = daily || err.limits?.imagesPerPhone === 5;
        error('');
        byId('phoneImageLimitMessage').textContent = free
          ? 'You have used your 5 image sends in the last 24 hours. Deleting images does not reset this allowance. Go Pro for 50 images stored per phone, or wait until an earlier send is more than 24 hours old.'
          : `Your phone has reached its ${err.limits?.imagesPerPhone || 50}-image limit. Delete a received image or wait for it to expire to free a slot.`;
        byId('phoneImageLimitUpgrade').hidden = !free;
        byId('phoneImageLimit').hidden = false;
        button.textContent = free ? 'Daily limit reached' : 'Phone full';
        (free ? byId('phoneImageLimitUpgrade') : byId('phoneImageLimit')).scrollIntoView?.({ block: 'nearest' });
        if (free) { byId('phoneImageLimitUpgrade').focus(); return; }
      }
      (byId('phoneTransferDevices').querySelector('button') || byId('phonePairCode')).focus();
    }
  }
  function makeButton(note) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'img-dl-btn phone-send-btn';
    button.textContent = '📱 Send to Phone';
    button.title = 'Upload only this image temporarily to your paired phone';
    chrome.storage.local.get('ct_phone_image_sends_v1').then(stored => {
      const sent = stored.ct_phone_image_sends_v1?.[String(note.imageId)];
      if (!sent || button.disabled) return;
      button.textContent = '✓ Sent · Send again';
      button.classList.add('phone-already-sent');
      button.title = `Already sent to ${sent.receiverName || 'your phone'} on ${new Date(sent.sentAt).toLocaleString()}. Click to send again. Cloud copies expire after 24 hours.`;
    });
    button.onclick = async event => {
      event.stopPropagation();
      pending = { note, button };
      try {
        await refresh();
        if (devices.length === 1 && configured) { pending = null; await send(note, button, devices[0]); }
        else { modal.classList.add('open'); showInstall(); }
      } catch (err) { pending = { note, button }; modal.classList.add('open'); error(err.message); }
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
  refresh().catch(() => {});
  setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 5000);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ct_phone_pairings_v1) refresh().catch(() => {});
  });
  globalThis.CacheTrayTransferUI = { makeButton };
})();
