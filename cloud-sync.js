/* exported CacheTrayCloud */
(function (root, factory) {
  const api = factory();
  root.CacheTrayCloud = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const AUTH_KEY = 'ct_cloud_auth_v1';
  const ENABLED_KEY = 'ct_cloud_enabled_v1';
  const STATUS_KEY = 'ct_cloud_status_v1';
  const DEVICE_KEY = 'ct_cloud_device_v1';
  const MAX_FIRESTORE_STRING_BYTES = 900000;

  function configured(config) {
    if (config?.useEmulators) return Boolean(config.projectId);
    return Boolean(config?.apiKey && config?.projectId);
  }

  function randomId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function byteLength(value) {
    return new TextEncoder().encode(value).length;
  }

  function sanitizeForCloud(data) {
    const clean = {
      uid: Number(data?.uid) || 0,
      current: data?.current || 'inbox',
      currentCat: data?.currentCat || 'all',
      modifiedAt: Number(data?.modifiedAt) || Date.now(),
      clusters: {}
    };
    let excludedImages = 0;
    for (const [name, cluster] of Object.entries(data?.clusters || {})) {
      const notes = [];
      for (const note of cluster?.notes || []) {
        if (note?.type === 'image') {
          excludedImages += 1;
          continue;
        }
        const copy = { ...note };
        delete copy.dataUrl;
        delete copy.imageUrl;
        delete copy.imageId;
        delete copy.imageHash;
        delete copy.thumb;
        notes.push(copy);
      }
      clean.clusters[name] = { color: cluster?.color || '#f87171', notes };
    }
    if (!Object.keys(clean.clusters).length) {
      clean.clusters.inbox = { color: '#f87171', notes: [] };
    }
    return { data: clean, excludedImages };
  }

  function hasSyncableContent(data) {
    return Object.values(data?.clusters || {}).some((cluster) =>
      (cluster?.notes || []).some((note) => note?.type !== 'image')
    );
  }

  function chooseSyncDirection(localData, remoteData) {
    if (!remoteData) return 'up';
    if (!hasSyncableContent(localData) && hasSyncableContent(remoteData)) return 'down';
    return Number(remoteData.modifiedAt) > Number(localData?.modifiedAt) ? 'down' : 'up';
  }

  function mergeCloudWithLocalImages(cloudData, localData) {
    const merged = JSON.parse(JSON.stringify(cloudData));
    merged.clusters ||= {};
    for (const [name, cluster] of Object.entries(localData?.clusters || {})) {
      const images = (cluster?.notes || []).filter((note) => note?.type === 'image');
      if (!images.length) continue;
      if (!merged.clusters[name]) {
        merged.clusters[name] = { color: cluster.color || '#f87171', notes: [] };
      }
      const remoteNotes = merged.clusters[name].notes || [];
      const remoteIds = new Set(remoteNotes.map((note) => `${note.type}:${note.id}`));
      merged.clusters[name].notes = [...images.filter((note) => !remoteIds.has(`image:${note.id}`)), ...remoteNotes]
        .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
    }
    return merged;
  }

  function authBase(config) {
    return config.useEmulators
      ? `${config.authEmulatorUrl.replace(/\/$/, '')}/identitytoolkit.googleapis.com`
      : 'https://identitytoolkit.googleapis.com';
  }

  function tokenBase(config) {
    return config.useEmulators
      ? `${config.authEmulatorUrl.replace(/\/$/, '')}/securetoken.googleapis.com`
      : 'https://securetoken.googleapis.com';
  }

  function firestoreDocumentUrl(config, uid) {
    const base = config.useEmulators
      ? `${config.firestoreEmulatorUrl.replace(/\/$/, '')}/v1`
      : 'https://firestore.googleapis.com/v1';
    return `${base}/projects/${encodeURIComponent(config.projectId)}/databases/(default)/documents/users/${encodeURIComponent(uid)}/cachetray/state`;
  }

  async function parseResponse(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body?.error?.message || body?.error || `Request failed (${response.status})`;
      throw new Error(String(message).replace(/_/g, ' '));
    }
    return body;
  }

  class RestClient {
    constructor(config, fetchImpl) {
      this.config = config;
      // Chromium's service-worker fetch is a Web API method. Calling a detached
      // reference can throw "Illegal invocation", so preserve its global receiver.
      this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    }

    async signInWithGoogle(accessToken, requestUri) {
      const response = await this.fetch(`${authBase(this.config)}/v1/accounts:signInWithIdp?key=${encodeURIComponent(this.config.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestUri,
          postBody: new URLSearchParams({ providerId: 'google.com', access_token: accessToken }).toString(),
          returnSecureToken: true,
          returnIdpCredential: true
        })
      });
      return parseResponse(response);
    }

    async signInToEmulator() {
      const key = encodeURIComponent(this.config.apiKey || 'local-test-key');
      const payload = {
        email: this.config.emulatorEmail,
        password: this.config.emulatorPassword,
        returnSecureToken: true
      };
      let response = await this.fetch(`${authBase(this.config)}/v1/accounts:signUp?key=${key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (response.ok) return response.json();
      const error = await response.json().catch(() => ({}));
      if (error?.error?.message !== 'EMAIL_EXISTS') return parseResponse({ ...response, json: async () => error });
      response = await this.fetch(`${authBase(this.config)}/v1/accounts:signInWithPassword?key=${key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      return parseResponse(response);
    }

    async refresh(refreshToken) {
      const response = await this.fetch(`${tokenBase(this.config)}/v1/token?key=${encodeURIComponent(this.config.apiKey || 'local-test-key')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString()
      });
      return parseResponse(response);
    }

    async readState(uid, idToken) {
      const response = await this.fetch(firestoreDocumentUrl(this.config, uid), {
        headers: { Authorization: `Bearer ${idToken}` }
      });
      if (response.status === 404) return null;
      const body = await parseResponse(response);
      const payload = body?.fields?.payload?.stringValue;
      if (!payload) return null;
      return JSON.parse(payload);
    }

    async writeState(uid, idToken, state) {
      const payload = JSON.stringify(state);
      if (byteLength(payload) > MAX_FIRESTORE_STRING_BYTES) {
        throw new Error('Sync data is too large for the Firestore preview');
      }
      const response = await this.fetch(firestoreDocumentUrl(this.config, uid), {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: {
          payload: { stringValue: payload },
          modifiedAt: { integerValue: String(Number(state.modifiedAt) || Date.now()) }
        } })
      });
      return parseResponse(response);
    }
  }

  function authRecord(result) {
    const expiresIn = Number(result.expiresIn || result.expires_in) || 3600;
    return {
      uid: result.localId || result.user_id,
      email: result.email || '',
      name: result.displayName || (result.email ? result.email.split('@')[0] : 'CacheTray user'),
      picture: result.photoUrl || '',
      idToken: result.idToken || result.id_token,
      refreshToken: result.refreshToken || result.refresh_token,
      expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000
    };
  }

  return {
    AUTH_KEY, ENABLED_KEY, STATUS_KEY, DEVICE_KEY, RestClient, configured,
    sanitizeForCloud, hasSyncableContent, chooseSyncDirection,
    mergeCloudWithLocalImages, authRecord, randomId, byteLength,
    firestoreDocumentUrl
  };
});
