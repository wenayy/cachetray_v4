(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const modal = byId('cloudSyncModal');
  const trigger = byId('cloudSyncBtn');
  let lastStatus = null;

  async function message(type) {
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok) throw new Error(response?.error || 'Cloud sync request failed');
    return response.status;
  }

  function relativeTime(time) {
    if (!time) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    return `${Math.floor(seconds / 60)}m ago`;
  }

  function setHidden(element, hidden) {
    element?.classList.toggle('hidden', hidden);
  }

  function render(status) {
    if (!status) return;
    lastStatus = status;
    const signedIn = Boolean(status.enabled && status.user);
    trigger.classList.toggle('active', signedIn);
    trigger.classList.toggle('syncing', Boolean(status.busy));
    trigger.title = signedIn ? `Cloud sync on · ${status.user.email || status.user.name}` : 'Cloud sync is off';

    const summary = byId('cloudSyncSummary');
    const signIn = byId('cloudSignInBtn');
    const signOut = byId('cloudSignOutBtn');
    const syncNow = byId('cloudSyncNowBtn');
    const user = byId('cloudUser');
    const error = byId('cloudSyncError');
    const setup = byId('cloudSyncSetup');

    signIn.disabled = Boolean(status.busy);
    syncNow.disabled = Boolean(status.busy);
    signOut.disabled = Boolean(status.busy);
    setHidden(signIn, signedIn);
    setHidden(signOut, !signedIn);
    setHidden(syncNow, !signedIn);
    setHidden(user, !signedIn);

    if (signedIn) {
      const syncText = status.busy
        ? 'Syncing…'
        : status.lastSyncAt
          ? `Synced ${relativeTime(status.lastSyncAt)} ${status.lastDirection === 'down' ? 'from cloud' : 'to cloud'}`
          : 'Signed in — ready to sync';
      summary.textContent = syncText;
      user.textContent = `${status.useEmulators ? 'Local test account' : (status.user.name || 'Google account')} · ${status.user.email || status.user.uid}`;
    } else {
      summary.textContent = status.configured
        ? 'Your clips stay local unless you turn sync on.'
        : 'Firebase setup is required before sign-in can run.';
      signIn.textContent = status.useEmulators ? 'Use local test account' : 'Continue with Google';
    }

    setHidden(error, !status.error);
    error.textContent = status.error || '';
    setHidden(setup, status.configured);
    if (!status.configured) {
      setup.textContent = `Add your Firebase project values in firebase-config.js. OAuth redirect: ${status.redirectUrl}`;
    }
    const notice = byId('cloudSyncNotice');
    notice.textContent = `${status.excludedImages || 0} image${status.excludedImages === 1 ? '' : 's'} will stay local. Text, code, links, tasks, and workspaces sync.`;
  }

  async function refresh() {
    try { render(await message('CLOUD_GET_STATUS')); }
    catch (error) { render({ ...(lastStatus || {}), error: error.message }); }
  }

  async function run(type) {
    if (lastStatus) render({ ...lastStatus, busy: true, error: '' });
    try { render(await message(type)); }
    catch (error) { render({ ...(lastStatus || {}), busy: false, error: error.message }); }
  }

  trigger?.addEventListener('click', () => { modal.classList.add('open'); refresh(); });
  byId('cloudSyncClose')?.addEventListener('click', () => modal.classList.remove('open'));
  modal?.addEventListener('click', (event) => { if (event.target === modal) modal.classList.remove('open'); });
  byId('cloudSignInBtn')?.addEventListener('click', () => run('CLOUD_SIGN_IN'));
  byId('cloudSignOutBtn')?.addEventListener('click', () => run('CLOUD_SIGN_OUT'));
  byId('cloudSyncNowBtn')?.addEventListener('click', () => run('CLOUD_SYNC_NOW'));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.ct_cloud_status_v1 || changes.ct_cloud_auth_v1 || changes.ct_cloud_enabled_v1)) refresh();
  });
  refresh();
})();
