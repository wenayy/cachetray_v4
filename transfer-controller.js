/* exported CacheTrayTransfer */
(function () {
  'use strict';
  const KEY = 'ct_phone_pairings_v1';
  const CONNECT_KEY = 'ct_phone_connect_pending_v1';
  const SENDER_KEY = 'ct_phone_sender_v1';
  const BILLING_KEY = 'ct_billing_recovery_v1';
  const CONNECT_ALARM = 'ct_phone_connect';
  let clipTimer = null;
  let pairingQueue = Promise.resolve();
  // QR, phrase pairing and background resume may overlap. Create/persist one identity at a time.
  function serialized(operation) {
    const result = pairingQueue.then(operation);
    pairingQueue = result.catch(() => {});
    return result;
  }
  const base = () => String(globalThis.CACHE_TRAY_TRANSFER_API || '').replace(/\/$/, '');
  function configured() { return base().startsWith('https://') && !base().includes('REPLACE_WITH'); }
  async function api(path, options = {}, token) {
    if (!configured()) throw new Error('Set the transfer API URL in transfer-config.js first');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(base() + path, {
        ...options, signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(body.error || `Transfer API error (${response.status})`);
        error.status = response.status;
        error.code = body.code;
        error.limits = body.limits;
        throw error;
      }
      return body;
    } finally { clearTimeout(timeout); }
  }
  async function devices() { return (await chrome.storage.local.get(KEY))[KEY] || []; }
  async function senderIdentity() {
    const stored = await chrome.storage.local.get([SENDER_KEY, KEY]);
    const existing = stored[SENDER_KEY] || stored[KEY]?.[0];
    if (existing?.senderToken) {
      const sender = { senderDeviceId: existing.senderDeviceId, senderToken: existing.senderToken };
      if (!stored[SENDER_KEY]) await chrome.storage.local.set({ [SENDER_KEY]: sender });
      return sender;
    }
    return null;
  }
  async function saveSender(device) {
    await chrome.storage.local.set({ [SENDER_KEY]: { senderDeviceId: device.senderDeviceId, senderToken: device.senderToken } });
  }
  async function accountStatus() {
    const sender = await senderIdentity();
    if (!sender) return { plan: 'free', maxPhones: 1, pairedPhones: 0 };
    const account = await api('/api/devices/me', {}, sender.senderToken);
    await chrome.storage.local.set({ ct_phone_plan_v1: account });
    // Only reconcile after a successful authoritative response, never on a network error.
    if (Array.isArray(account.devices)) {
      const previous = await devices();
      const verified = account.devices.map(device => ({ ...device, ...sender }));
      // Older versions could save a different sender credential per phone. Verify those
      // separately rather than silently dropping a genuinely paired second phone.
      const legacy = new Map(previous.filter(device => device.senderDeviceId !== sender.senderDeviceId)
        .map(device => [device.senderDeviceId, device]));
      for (const old of legacy.values()) {
        try {
          const other = await api('/api/devices/me', {}, old.senderToken);
          if (Array.isArray(other.devices)) verified.push(...other.devices.map(device => ({ ...device,
            senderDeviceId: old.senderDeviceId, senderToken: old.senderToken })));
          else verified.push(...previous.filter(device => device.senderDeviceId === old.senderDeviceId));
        } catch (error) {
          if (error.status !== 401) verified.push(...previous.filter(device => device.senderDeviceId === old.senderDeviceId));
        }
      }
      account.pairedPhones = verified.length;
      if (JSON.stringify(previous) !== JSON.stringify(verified)) await chrome.storage.local.set({ [KEY]: verified });
    }
    return account;
  }
  async function pair(code) {
    const sender = await senderIdentity();
    const device = await api('/api/devices/pair', { method: 'POST', body: JSON.stringify({ code }) }, sender?.senderToken);
    await saveSender(device);
    const list = await devices();
    const next = [...list.filter(item => item.receiverDeviceId !== device.receiverDeviceId), device];
    await chrome.storage.local.set({ [KEY]: next });
    scheduleClipSync();
    return next;
  }
  async function disconnect(receiverDeviceId) {
    const list = await devices();
    const device = list.find(item => item.receiverDeviceId === receiverDeviceId);
    if (!device) return list;
    await api(`/api/devices/${encodeURIComponent(receiverDeviceId)}/pairing`, { method: 'DELETE' }, device.senderToken);
    await chrome.storage.local.remove(CONNECT_KEY);
    await chrome.alarms.clear(CONNECT_ALARM);
    const next = list.filter(item => item.receiverDeviceId !== receiverDeviceId);
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  }
  async function startConnect() {
    const sender = await senderIdentity();
    const session = await api('/api/connect/start', { method: 'POST' }, sender?.senderToken);
    await saveSender(session);
    await chrome.storage.local.set({ [CONNECT_KEY]: session });
    chrome.alarms.create(CONNECT_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
    return session;
  }
  async function pendingConnect() {
    const session = (await chrome.storage.local.get(CONNECT_KEY))[CONNECT_KEY];
    if (!session) return null;
    if (session.expiresAt > Date.now()) return session;
    await chrome.storage.local.remove(CONNECT_KEY);
    await chrome.alarms.clear(CONNECT_ALARM);
    return null;
  }
  async function clearConnectSession(session) {
    const current = (await chrome.storage.local.get(CONNECT_KEY))[CONNECT_KEY];
    if (current?.connectId !== session.connectId) return;
    await chrome.storage.local.remove(CONNECT_KEY);
    await chrome.alarms.clear(CONNECT_ALARM);
  }
  async function connectStatus(session) {
    let result;
    try { result = await api(`/api/connect/${encodeURIComponent(session.connectId)}`, {}, session.senderToken); }
    catch (error) {
      if (![404, 410].includes(error.status)) throw error;
      await clearConnectSession(session);
      return { connected: false, expired: true };
    }
    if (!result.connected) {
      if (result.expired) await pendingConnect();
      return result;
    }
    const device = { senderDeviceId: session.senderDeviceId, senderToken: session.senderToken,
      receiverDeviceId: result.receiverDeviceId, receiverName: result.receiverName };
    const list = await devices();
    await chrome.storage.local.set({ [KEY]: [...list.filter(item => item.receiverDeviceId !== device.receiverDeviceId), device] });
    await clearConnectSession(session);
    scheduleClipSync();
    return result;
  }
  async function resumeConnect() {
    const session = await pendingConnect();
    if (session) await connectStatus(session);
  }
  async function syncClips() {
    const paired = await devices();
    if (!paired.length) return;
    const stored = await chrome.storage.local.get('quicknotes_v1');
    const data = stored.quicknotes_v1;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const allCandidates = Object.values(data?.clusters || {}).flatMap(cluster => cluster.notes || [])
      .filter(note => ['text', 'code', 'link', 'task'].includes(note.type) && note.time > cutoff)
      .sort((a, b) => b.time - a.time)
      .map(note => ({ id: note.id, type: note.type, time: note.time,
        content: String(note.content || '').slice(0, 10_000),
        full: String(note.full || '').slice(0, 20_000),
        url: String(note.url || '').slice(0, 2_000), done: note.done === true }));
    for (const device of paired) {
      if (device.enabled === false) continue;
      try {
        const account = await api('/api/devices/me', {}, device.senderToken);
        await chrome.storage.local.set({ ct_phone_plan_v1: account });
        const cap = account.limits?.clipsPerCategory || 20;
        const counts = { text: 0, link: 0, code: 0, task: 0 };
        const items = [];
        let bytes = 12;
        for (const item of allCandidates) {
          if (counts[item.type] >= cap) continue;
          const size = new TextEncoder().encode(JSON.stringify(item)).length + 1;
          if (bytes + size > 200_000) continue;
          counts[item.type]++; items.push(item); bytes += size;
        }
        await api(`/api/devices/${encodeURIComponent(device.receiverDeviceId)}/clips`,
          { method: 'PUT', body: JSON.stringify({ items }) }, device.senderToken);
      } catch (error) {
        if (error.status === 403) await serialized(accountStatus).catch(() => {});
        console.warn('CacheTray phone clip sync failed', error);
      }
    }
  }
  function scheduleClipSync() {
    clearTimeout(clipTimer);
    clipTimer = setTimeout(() => { syncClips().catch(error => console.warn('CacheTray phone clip sync failed', error)); }, 1500);
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
    try {
      const upload = await fetch(start.uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob,
        signal: AbortSignal.timeout(60000) });
      if (!upload.ok) throw new Error(`Image upload failed (${upload.status}). Please try again.`);
    } catch (error) {
      await api(`/api/transfers/${encodeURIComponent(start.transferId)}/abort`, { method: 'POST' }, device.senderToken).catch(() => {});
      throw error;
    }
    await api(`/api/transfers/${encodeURIComponent(start.transferId)}/ready`, { method: 'POST' }, device.senderToken);
    // Record successful sends only after the backend verified the uploaded Blob.
    await serialized(async () => {
      const key = 'ct_phone_image_sends_v1';
      const stored = await chrome.storage.local.get([key, 'quicknotes_v1']);
      const history = stored[key] || {};
      if (stored.quicknotes_v1?.clusters) {
        const imageIds = new Set(Object.values(stored.quicknotes_v1.clusters)
          .flatMap(cluster => cluster.notes || []).filter(note => note.imageId != null).map(note => String(note.imageId)));
        for (const id of Object.keys(history)) if (!imageIds.has(id)) delete history[id];
      }
      history[String(imageId)] = { sentAt: Date.now(), receiverName: device.receiverName,
        receiverDeviceId, transferId: start.transferId };
      await chrome.storage.local.set({ [key]: history });
    }).catch(error => console.warn('Could not save send history', error));
    return { transferId: start.transferId, receiverName: device.receiverName };
  }
  async function billingIdentity() {
    let sender = await senderIdentity();
    if (!sender) { await startConnect(); sender = await senderIdentity(); }
    return sender;
  }
  async function prepareBilling(newKey = false) {
    await billingIdentity();
    let key = (await chrome.storage.local.get(BILLING_KEY))[BILLING_KEY];
    if (!key || newKey) {
      key = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
      await chrome.storage.local.set({ [BILLING_KEY]: key });
    }
    return { recoveryKey: key, account: await accountStatus() };
  }
  async function billingAction(action, recoveryKey) {
    const sender = await billingIdentity();
    if (action === 'checkout') recoveryKey = (await chrome.storage.local.get(BILLING_KEY))[BILLING_KEY];
    const result = await api(`/api/billing/${action}`, { method: 'POST', body: JSON.stringify({ recoveryKey }) }, sender.senderToken);
    if (action === 'restore') { await chrome.storage.local.set({ [BILLING_KEY]: recoveryKey.trim().toLowerCase() }); scheduleClipSync(); }
    return result;
  }
  globalThis.CacheTrayTransfer = { configured, devices, send, syncClips, scheduleClipSync,
    resumeConnect: () => serialized(resumeConnect),
    pendingConnect: () => serialized(pendingConnect),
    pair: code => serialized(() => pair(code)),
    disconnect: id => serialized(() => disconnect(id)),
    startConnect: () => serialized(startConnect),
    connectStatus: session => serialized(() => connectStatus(session)),
    accountStatus: () => serialized(accountStatus) };
  globalThis.CacheTrayTransfer.prepareBilling = newKey => serialized(() => prepareBilling(newKey));
  globalThis.CacheTrayTransfer.billingAction = (action, key) => serialized(() => billingAction(action, key));
})();
