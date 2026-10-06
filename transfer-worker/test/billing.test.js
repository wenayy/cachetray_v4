import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { fakeEnv } from './sqlite-env.js';
import { verifyWebhook } from '../src/billing.js';

async function call(env, method, path, body, token) {
  const response = await worker.fetch(new Request(`https://worker.example${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  }), env);
  return { status: response.status, body: await response.json() };
}
async function paired(env) {
  const phone = (await call(env, 'POST', '/api/devices/register', { name: 'Pixel' })).body;
  const mac = (await call(env, 'POST', '/api/devices/pair', { code: phone.pairingCode })).body;
  return { phone, mac };
}
const image = receiverDeviceId => ({ receiverDeviceId, filename: 'test.png', mimeType: 'image/png', byteSize: 3, type: 'image' });

test('Free daily sends are atomic; deletion, inbox expiry and cleanup cannot reset the quota', async () => {
  const env = fakeEnv();
  const { phone, mac } = await paired(env);
  const starts = await Promise.all(Array.from({ length: 6 }, () => call(env, 'POST', '/api/transfers', image(phone.deviceId), mac.senderToken)));
  assert.equal(starts.filter(result => result.status === 201).length, 5);
  assert.equal(starts.filter(result => result.status === 403).length, 1);
  assert.equal(starts.find(result => result.status === 403).body.code, 'DAILY_IMAGE_LIMIT');
  env.setObject({ size: 3, httpMetadata: { contentType: 'image/png' } });
  for (const result of starts.filter(result => result.status === 201)) {
    assert.equal((await call(env, 'POST', `/api/transfers/${result.body.transferId}/ready`, null, mac.senderToken)).status, 200);
  }
  const id = starts.find(result => result.status === 201).body.transferId;
  assert.equal((await call(env, 'POST', `/api/transfers/${id}/ready`, null, mac.senderToken)).status, 200);
  assert.equal((await call(env, 'GET', '/api/devices/me', null, mac.senderToken)).body.usage.imagesUsed, 5);
  await call(env, 'DELETE', `/api/transfers/${id}`, null, phone.deviceToken);
  const replacement = await call(env, 'POST', '/api/transfers', image(phone.deviceId), mac.senderToken);
  assert.equal(replacement.status, 403);
  await worker.scheduled({}, env);
  assert.equal((await call(env, 'GET', '/api/devices/me', null, mac.senderToken)).body.usage.imagesSentLast24h, 5);
  env.sqlite.prepare("UPDATE transfers SET expires_at = ? WHERE status = 'ready'").run(Date.now() - 1);
  assert.equal((await call(env, 'POST', '/api/transfers', image(phone.deviceId), mac.senderToken)).status, 403);
  env.sqlite.prepare("UPDATE image_usage SET sent_at = ? WHERE transfer_id = ?").run(Date.now() - 86400001, id);
  const renewed = await call(env, 'POST', '/api/transfers', image(phone.deviceId), mac.senderToken);
  assert.equal(renewed.status, 201);
  assert.equal((await call(env, 'POST', `/api/transfers/${renewed.body.transferId}/abort`, null, mac.senderToken)).status, 200);
  assert.equal((await call(env, 'POST', '/api/transfers', image(phone.deviceId), mac.senderToken)).status, 201);
});

test('other senders cannot publish or cancel an upload; expired reservations cannot publish', async () => {
  const env = fakeEnv();
  const { phone, mac } = await paired(env);
  const other = await paired(env);
  const transfer = (await call(env, 'POST', '/api/transfers', image(phone.deviceId), mac.senderToken)).body;
  assert.equal((await call(env, 'POST', `/api/transfers/${transfer.transferId}/ready`, null, other.mac.senderToken)).status, 404);
  assert.equal((await call(env, 'POST', `/api/transfers/${transfer.transferId}/abort`, null, other.mac.senderToken)).status, 404);
  env.sqlite.prepare('UPDATE image_usage SET reserved_until = ?').run(Date.now() - 1);
  env.setObject({ size: 3, httpMetadata: { contentType: 'image/png' } });
  assert.equal((await call(env, 'POST', `/api/transfers/${transfer.transferId}/ready`, null, mac.senderToken)).status, 410);
});

test('Pro exact limits: 50 images on each phone and 100 clips in each category', async () => {
  const env = fakeEnv();
  const { phone, mac } = await paired(env);
  env.setPlan(mac.senderDeviceId, 'pro');
  const account = (await call(env, 'GET', '/api/devices/me', null, mac.senderToken)).body;
  assert.deepEqual(account.limits, { imagesPerPhone: 50, clipsPerCategory: 100, phones: 2 });
  const items = ['text', 'link', 'code', 'task'].flatMap(type => Array.from({ length: 101 }, (_, i) => ({ id: `${type}-${i}`, type, content: 'clip', time: Date.now() - i })));
  const path = `/api/devices/${phone.deviceId}/clips`;
  assert.equal((await call(env, 'PUT', path, { items }, mac.senderToken)).body.synced, 400);
  const saved = (await call(env, 'GET', path, null, phone.deviceToken)).body.items;
  for (const type of ['text', 'link', 'code', 'task']) assert.equal(saved.filter(item => item.type === type).length, 100);
  for (let i = 0; i < 50; i++) assert.equal(await import('../src/plans.js').then(({ reserveImage }) => reserveImage(env, { id: mac.senderDeviceId, plan: 'pro' }, phone.deviceId, `pro-${i}`)), true);
  assert.equal(await import('../src/plans.js').then(({ reserveImage }) => reserveImage(env, { id: mac.senderDeviceId, plan: 'pro' }, phone.deviceId, 'overflow')), false);
});

test('merged phone inbox caps Free clips across multiple paired Macs', async () => {
  const env = fakeEnv();
  const { phone, mac: first } = await paired(env);
  const refreshed = (await call(env, 'POST', `/api/devices/${phone.deviceId}/pair-code`, {}, phone.deviceToken)).body;
  const second = await call(env, 'POST', '/api/devices/pair', { code: refreshed.pairingCode });
  assert.equal(second.status, 201);
  const send = async (mac, count, prefix) => {
    const items = Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, type: 'text', content: prefix, time: Date.now() - i }));
    await call(env, 'PUT', `/api/devices/${phone.deviceId}/clips`, { items }, mac.senderToken);
  };
  await send(first, 20, 'first');
  await send(second.body, 20, 'second');
  let inbox = (await call(env, 'GET', `/api/devices/${phone.deviceId}/clips`, null, phone.deviceToken)).body;
  assert.equal(inbox.items.length, 20);
  assert.equal(inbox.clipsPerCategory, 20);
  env.setPlan(second.body.senderDeviceId, 'pro');
  await send(second.body, 100, 'pro');
  inbox = (await call(env, 'GET', `/api/devices/${phone.deviceId}/clips`, null, phone.deviceToken)).body;
  assert.equal(inbox.items.length, 100);
  assert.equal(inbox.clipsPerCategory, 100);
});

test('simultaneous checkout requests create one provider session; timeout cannot duplicate it', async () => {
  const env = fakeEnv();
  Object.assign(env, { DODO_API_KEY: 'test', DODO_WEBHOOK_SECRET: secret, DODO_PRODUCT_ID: 'pro', DODO_MODE: 'test' });
  const { mac } = await paired(env);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; await new Promise(setImmediate); return Response.json({ session_id: 'one', checkout_url: 'https://checkout.dodopayments.com/one' }); };
  try {
    const responses = await Promise.all(Array.from({ length: 3 }, () => call(env, 'POST', '/api/billing/checkout', { recoveryKey: 'a'.repeat(64) }, mac.senderToken)));
    assert.equal(calls, 1);
    assert.ok(responses.some(result => result.status === 200));
    const second = await paired(env);
    globalThis.fetch = async () => { calls++; throw new Error('Provider timeout'); };
    assert.equal((await call(env, 'POST', '/api/billing/checkout', { recoveryKey: 'b'.repeat(64) }, second.mac.senderToken)).status, 500);
    const before = calls;
    assert.equal((await call(env, 'POST', '/api/billing/checkout', { recoveryKey: 'b'.repeat(64) }, second.mac.senderToken)).status, 409);
    assert.equal((await call(env, 'POST', '/api/billing/checkout', { recoveryKey: 'c'.repeat(64) }, second.mac.senderToken)).status, 409);
    assert.equal(calls, before);
  } finally { globalThis.fetch = originalFetch; }
});

test('newest 20 clips in each category; old Pro snapshots are clamped after downgrade', async () => {
  const env = fakeEnv();
  const { phone, mac } = await paired(env);
  const items = ['text', 'link', 'code', 'task'].flatMap(type => Array.from({ length: 25 }, (_, i) => ({ id: `${type}-${i}`, type, content: 'clip', time: Date.now() - i })));
  const path = `/api/devices/${phone.deviceId}/clips`;
  assert.equal((await call(env, 'PUT', path, { items }, mac.senderToken)).body.synced, 80);
  let result = (await call(env, 'GET', path, null, phone.deviceToken)).body.items;
  for (const type of ['text', 'link', 'code', 'task']) {
    assert.equal(result.filter(item => item.type === type).length, 20);
    assert.ok(!result.some(item => item.id === `${type}-24`));
  }
  env.setPlan(mac.senderDeviceId, 'pro');
  assert.equal((await call(env, 'PUT', path, { items }, mac.senderToken)).body.synced, 100);
  env.setPlan(mac.senderDeviceId, 'free');
  result = (await call(env, 'GET', path, null, phone.deviceToken)).body.items;
  assert.equal(result.length, 80);
});

test('downgrade disables second phone without removing received images', async () => {
  const env = fakeEnv();
  const { phone, mac } = await paired(env);
  env.setPlan(mac.senderDeviceId, 'pro');
  const second = (await call(env, 'POST', '/api/devices/register', { name: 'iPhone' })).body;
  await call(env, 'POST', '/api/devices/pair', { code: second.pairingCode }, mac.senderToken);
  env.setPlan(mac.senderDeviceId, 'free');
  const phones = (await call(env, 'GET', '/api/devices/me', null, mac.senderToken)).body.devices;
  assert.equal(phones.filter(p => p.enabled).length, 1);
  const disabled = phones.find(p => !p.enabled).receiverDeviceId;
  assert.equal((await call(env, 'PUT', `/api/devices/${disabled}/clips`, { items: [] }, mac.senderToken)).status, 403);
  assert.equal((await call(env, 'POST', '/api/transfers', image(disabled), mac.senderToken)).status, 403);
  assert.equal((await call(env, 'GET', `/api/devices/${phone.deviceId}/transfers`, null, phone.deviceToken)).status, 200);
});

const secret = 'whsec_' + btoa('a test webhook signing secret');
async function signedEvent(event, timestamp = Math.floor(Date.now() / 1000), id = crypto.randomUUID()) {
  const raw = JSON.stringify(event);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('a test webhook signing secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${raw}`)));
  return new Request('https://worker.example/api/billing/webhook', { method: 'POST', body: raw,
    headers: { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': 'v1,' + btoa(String.fromCharCode(...bytes)) } });
}
test('webhook verification rejects tampering, expired timestamps and missing signatures', async () => {
  const request = await signedEvent({ type: 'subscription.active' });
  const raw = await request.clone().text();
  assert.equal(await verifyWebhook(request, raw, secret), true);
  assert.equal(await verifyWebhook(request, raw + ' ', secret), false);
  const expired = await signedEvent({}, Math.floor(Date.now() / 1000) - 600);
  assert.equal(await verifyWebhook(expired, '{}', secret), false);
  assert.equal(await verifyWebhook(new Request('https://example.com'), '{}', secret), false);
});

test('checkout, verified activation, duplicate events, cancellation and recovery transfer', async () => {
  const env = fakeEnv();
  Object.assign(env, { DODO_API_KEY: 'test-only', DODO_WEBHOOK_SECRET: secret, DODO_PRODUCT_ID: 'pro-product', DODO_MODE: 'test' });
  const { mac } = await paired(env);
  const key = 'a'.repeat(64);
  const originalFetch = globalThis.fetch;
  let subscription;
  let providerRequests = 0;
  globalThis.fetch = async (url, options = {}) => {
    providerRequests++;
    if (url.endsWith('/checkouts')) {
      const body = JSON.parse(options.body);
      assert.equal(body.product_cart[0].product_id, 'pro-product');
      subscription = { subscription_id: 'sub-test', product_id: 'pro-product', metadata: body.metadata,
        customer: { customer_id: 'customer-test' }, status: 'active', next_billing_date: new Date(Date.now() + 30 * 86400000).toISOString() };
      return Response.json({ session_id: 'checkout-test', checkout_url: 'https://checkout.dodopayments.com/test' });
    }
    if (url.includes('/subscriptions/')) return Response.json(subscription);
    if (url.includes('/customer-portal/session')) return Response.json({ link: 'https://customer.dodopayments.com/test' });
    throw new Error(`Unexpected provider path ${url}`);
  };
  try {
    assert.equal((await call(env, 'POST', '/api/billing/checkout', { recoveryKey: key }, mac.senderToken)).status, 200);
    const checkoutRequests = providerRequests;
    assert.equal((await call(env, 'POST', '/api/billing/checkout', { recoveryKey: key }, mac.senderToken)).status, 200);
    assert.equal(providerRequests, checkoutRequests, 'retry reuses the checkout, never creates another charge');
    assert.equal((await call(env, 'POST', '/api/billing/checkout', { recoveryKey: 'c'.repeat(64) }, mac.senderToken)).status, 409);
    assert.equal((await call(env, 'GET', '/api/devices/me', null, mac.senderToken)).body.plan, 'free');
    const active = await signedEvent({ type: 'subscription.active', data: { subscription_id: 'sub-test' }, timestamp: new Date().toISOString() });
    const duplicate = active.clone();
    assert.equal((await worker.fetch(active, env)).status, 200);
    assert.equal((await call(env, 'GET', '/api/devices/me', null, mac.senderToken)).body.plan, 'pro');
    // A paid sandbox subscription must never grant live access or be reused at checkout.
    env.DODO_MODE = 'live';
    const liveStatus = (await call(env, 'GET', '/api/devices/me', null, mac.senderToken)).body;
    assert.equal(liveStatus.plan, 'free');
    assert.equal(liveStatus.billing.hasSubscription, false);
    assert.equal((await call(env, 'POST', '/api/billing/restore', { recoveryKey: key }, mac.senderToken)).status, 409);
    assert.equal((await call(env, 'POST', '/api/billing/checkout', { recoveryKey: key }, mac.senderToken)).status, 409);
    assert.equal((await call(env, 'POST', '/api/billing/portal', {}, mac.senderToken)).status, 404);
    env.DODO_MODE = 'test';
    const priorProduct = env.DODO_PRODUCT_ID;
    env.DODO_PRODUCT_ID = 'different-product';
    assert.equal((await call(env, 'GET', '/api/devices/me', null, mac.senderToken)).body.plan, 'free');
    env.DODO_PRODUCT_ID = priorProduct;
    assert.equal((await call(env, 'GET', '/api/devices/me', null, mac.senderToken)).body.plan, 'pro');
    const count = providerRequests;
    await worker.fetch(duplicate, env);
    assert.equal(providerRequests, count);
    assert.equal((await call(env, 'POST', '/api/billing/checkout', { recoveryKey: key }, mac.senderToken)).status, 409);
    assert.equal((await call(env, 'POST', '/api/billing/portal', {}, mac.senderToken)).status, 200);
    const other = await paired(env);
    assert.equal((await call(env, 'POST', '/api/billing/restore', { recoveryKey: 'b'.repeat(64) }, other.mac.senderToken)).status, 404);
    assert.equal((await call(env, 'POST', '/api/billing/restore', { recoveryKey: key }, other.mac.senderToken)).status, 200);
    assert.equal((await call(env, 'GET', '/api/devices/me', null, other.mac.senderToken)).body.plan, 'pro');
    assert.equal((await call(env, 'GET', '/api/devices/me', null, mac.senderToken)).body.plan, 'free');
    subscription.status = 'cancelled';
    await worker.fetch(await signedEvent({ type: 'subscription.active', data: { subscription_id: 'sub-test' }, timestamp: new Date(Date.now() - 60000).toISOString() }), env);
    assert.equal((await call(env, 'GET', '/api/devices/me', null, other.mac.senderToken)).body.plan, 'free');
  } finally { globalThis.fetch = originalFetch; }
});

test('billing unavailable without secrets; unsigned webhooks cannot grant Pro', async () => {
  const env = fakeEnv();
  const { mac } = await paired(env);
  assert.equal((await call(env, 'POST', '/api/billing/checkout', { recoveryKey: 'a'.repeat(64) }, mac.senderToken)).status, 503);
  Object.assign(env, { DODO_API_KEY: 'test', DODO_WEBHOOK_SECRET: secret, DODO_PRODUCT_ID: 'pro', DODO_MODE: 'test' });
  assert.equal((await call(env, 'POST', '/api/billing/webhook', { type: 'subscription.active' })).status, 401);
  assert.equal((await call(env, 'GET', '/api/devices/me', null, mac.senderToken)).body.plan, 'free');
});

test('client supplied Pro fields cannot grant quota; excessive upload attempts are throttled', async () => {
  const env = fakeEnv();
  const phone = (await call(env, 'POST', '/api/devices/register', { name: 'Pixel', plan: 'pro' })).body;
  const mac = (await call(env, 'POST', '/api/devices/pair', { code: phone.pairingCode, plan: 'pro', maxPhones: 999 })).body;
  const account = (await call(env, 'GET', '/api/devices/me', null, mac.senderToken)).body;
  assert.equal(account.plan, 'free');
  assert.equal(account.maxPhones, 1);
  for (let i = 0; i < 60; i++) {
    const response = await call(env, 'POST', '/api/transfers', { ...image(phone.deviceId), plan: 'pro', imagesPerPhone: 999 }, mac.senderToken);
    assert.equal(response.status, i < 5 ? 201 : 403);
  }
  assert.equal((await call(env, 'POST', '/api/transfers', image(phone.deviceId), mac.senderToken)).status, 429);
  assert.equal((await call(env, 'GET', `/api/devices/${phone.deviceId}/clips`, null, mac.senderToken)).status, 401);
});
