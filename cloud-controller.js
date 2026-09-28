/* exported CacheTrayCloudController */
(function () {
  'use strict';

  const Cloud = globalThis.CacheTrayCloud;
  const config = globalThis.CACHE_TRAY_FIREBASE_CONFIG || {};
  const client = new Cloud.RestClient(config);
  const STORAGE_KEY = 'quicknotes_v1';
  let uploadTimer = null;
  let syncPromise = null;

  async function getStored(keys) {
    return chrome.storage.local.get(keys);
  }

  async function setStatus(patch) {
    const stored = await getStored(Cloud.STATUS_KEY);
    const next = { ...(stored[Cloud.STATUS_KEY] || {}), ...patch };
    await chrome.storage.local.set({ [Cloud.STATUS_KEY]: next });
    return next;
  }

  async function getAuth() {
    const stored = await getStored(Cloud.AUTH_KEY);
    return stored[Cloud.AUTH_KEY] || null;
  }

  async function validAuth() {
    let auth = await getAuth();
    if (!auth) throw new Error('Sign in to enable sync');
    if (auth.expiresAt > Date.now() && auth.idToken) return auth;
    const refreshed = await client.refresh(auth.refreshToken);
    auth = { ...auth, ...Cloud.authRecord(refreshed), email: auth.email, name: auth.name, picture: auth.picture };
    await chrome.storage.local.set({ [Cloud.AUTH_KEY]: auth });
    return auth;
  }

  async function deviceId() {
    const stored = await getStored(Cloud.DEVICE_KEY);
    if (stored[Cloud.DEVICE_KEY]) return stored[Cloud.DEVICE_KEY];
    const id = Cloud.randomId();
    await chrome.storage.local.set({ [Cloud.DEVICE_KEY]: id });
    return id;
  }

  async function status() {
    const stored = await getStored([Cloud.AUTH_KEY, Cloud.ENABLED_KEY, Cloud.STATUS_KEY, STORAGE_KEY]);
    const auth = stored[Cloud.AUTH_KEY];
    const localData = stored[STORAGE_KEY];
    const { excludedImages } = Cloud.sanitizeForCloud(localData || {});
    return {
      configured: Cloud.configured(config),
      useEmulators: Boolean(config.useEmulators),
      enabled: stored[Cloud.ENABLED_KEY] === true && Boolean(auth),
      user: auth ? { uid: auth.uid, email: auth.email, name: auth.name, picture: auth.picture } : null,
      excludedImages,
      redirectUrl: chrome.identity.getRedirectURL('firebase'),
      ...(stored[Cloud.STATUS_KEY] || {})
    };
  }

  async function launchGoogleSignIn() {
    // OAuth tokens are cached by Chrome. If the manifest's OAuth client changes
    // during development, an old token can retain the previous client audience
    // and Firebase rejects it with INVALID_IDP_RESPONSE.
    await chrome.identity.clearAllCachedAuthTokens();
    const tokenResult = await chrome.identity.getAuthToken({ interactive: true });
    const token = typeof tokenResult === 'string' ? tokenResult : tokenResult?.token;
    if (!token) throw new Error('Google did not return an access token');
    try {
      return await client.signInWithGoogle(token, `https://${chrome.runtime.id}.chromiumapp.org`);
    } catch (error) {
      await chrome.identity.removeCachedAuthToken({ token }).catch(() => {});
      throw error;
    }
  }

  async function signIn() {
    if (!Cloud.configured(config)) throw new Error('Firebase is not configured yet');
    await setStatus({ busy: true, error: '' });
    try {
      const result = config.useEmulators ? await client.signInToEmulator() : await launchGoogleSignIn();
      const auth = Cloud.authRecord(result);
      if (!auth.uid || !auth.idToken) throw new Error('Firebase returned an incomplete sign-in response');
      await chrome.storage.local.set({ [Cloud.AUTH_KEY]: auth, [Cloud.ENABLED_KEY]: true });
      await syncNow('signin');
      return status();
    } catch (error) {
      await setStatus({ error: error.message, busy: false });
      throw error;
    }
  }

  async function signOut() {
    await chrome.storage.local.remove([Cloud.AUTH_KEY, Cloud.ENABLED_KEY]);
    await setStatus({ busy: false, error: '', lastSyncAt: 0, lastDirection: '' });
    return status();
  }

  async function syncNow(reason) {
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      const stored = await getStored([Cloud.ENABLED_KEY, STORAGE_KEY]);
      if (stored[Cloud.ENABLED_KEY] !== true) return status();
      await setStatus({ busy: true, error: '' });
      try {
        const auth = await validAuth();
        const local = stored[STORAGE_KEY] || { clusters: { inbox: { color: '#f87171', notes: [] } }, uid: 0 };
        const sanitized = Cloud.sanitizeForCloud(local);
        const remote = await client.readState(auth.uid, auth.idToken);
        const direction = Cloud.chooseSyncDirection(sanitized.data, remote);
        if (direction === 'down') {
          const merged = Cloud.mergeCloudWithLocalImages(remote, local);
          await chrome.storage.local.set({ [STORAGE_KEY]: merged });
        } else {
          await client.writeState(auth.uid, auth.idToken, {
            ...sanitized.data,
            deviceId: await deviceId()
          });
        }
        await setStatus({
          busy: false, error: '', lastSyncAt: Date.now(), lastDirection: direction,
          excludedImages: sanitized.excludedImages, reason: reason || 'manual'
        });
        return status();
      } catch (error) {
        await setStatus({ busy: false, error: error.message });
        throw error;
      } finally {
        syncPromise = null;
      }
    })();
    return syncPromise;
  }

  function scheduleUpload() {
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => { syncNow('local-change').catch(() => {}); }, 900);
  }

  globalThis.CacheTrayCloudController = { status, signIn, signOut, syncNow, scheduleUpload };
})();
