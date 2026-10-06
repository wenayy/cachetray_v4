import { DAY } from './plans.js';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (error, status = 400) => json({ error }, status);
const sha256 = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
export const billingConfigured = env => Boolean(env.DODO_API_KEY && env.DODO_WEBHOOK_SECRET && env.DODO_PRODUCT_ID
  && ['test', 'live'].includes(env.DODO_MODE));

async function dodo(env, path, method = 'GET', body) {
  if (!billingConfigured(env)) throw new Error('Billing is not configured');
  const base = env.DODO_MODE === 'live' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com';
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${env.DODO_API_KEY}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`Billing provider request failed (${response.status})`);
  return response.json();
}

// Official Standard Webhooks format; verify the untouched body before JSON parsing.
export async function verifyWebhook(request, raw, secret, now = Date.now()) {
  const id = request.headers.get('webhook-id');
  const timestamp = request.headers.get('webhook-timestamp');
  const signatures = request.headers.get('webhook-signature') || '';
  if (!id || id.length > 200 || !/^\d+$/.test(timestamp || '') || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  try {
    const bytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), character => character.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const content = new TextEncoder().encode(`${id}.${timestamp}.${raw}`);
    for (const signature of signatures.split(/\s+/)) {
      const [version, encoded] = signature.split(',');
      if (version !== 'v1' || !encoded) continue;
      const candidate = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      if (await crypto.subtle.verify('HMAC', key, candidate, content)) return true;
    }
  } catch (_) { /* Malformed signatures are unauthorized. */ }
  return false;
}

export async function effectiveDevice(env, device) {
  if (!device || device.platform !== 'chrome-extension') return device;
  const subscription = await env.DB.prepare(`SELECT status, valid_until FROM billing_subscriptions
    WHERE sender_id = ? AND billing_mode = ? AND product_id = ? ORDER BY event_at DESC LIMIT 1`)
    .bind(device.id, env.DODO_MODE || 'test', env.DODO_PRODUCT_ID || '').first();
  if (!subscription) {
    const other = await env.DB.prepare('SELECT id FROM billing_subscriptions WHERE sender_id = ? LIMIT 1').bind(device.id).first();
    return other ? { ...device, plan: 'free' } : device; // Never carry a sandbox grant into live mode.
  }
  return { ...device, plan: subscription.status === 'active' && subscription.valid_until > Date.now() ? 'pro' : 'free' };
}

export async function billingSummary(env, senderId) {
  const row = await env.DB.prepare(`SELECT id, status, valid_until FROM billing_subscriptions
    WHERE sender_id = ? AND billing_mode = ? AND product_id = ? ORDER BY event_at DESC LIMIT 1`)
    .bind(senderId, env.DODO_MODE || 'test', env.DODO_PRODUCT_ID || '').first();
  return { available: billingConfigured(env), mode: env.DODO_MODE || 'test',
    subscribed: Boolean(row && ['active', 'on_hold', 'paused', 'past_due', 'pending'].includes(row.status)),
    hasSubscription: Boolean(row), status: row?.status || null, validUntil: row?.valid_until || null };
}

async function applySubscription(env, subscription, eventId, eventAt) {
  if (subscription.product_id !== env.DODO_PRODUCT_ID) return false;
  const checkoutId = subscription.metadata?.cachetray_checkout_id;
  const checkout = await env.DB.prepare('SELECT id, sender_id, billing_mode, product_id FROM billing_checkouts WHERE id = ?').bind(checkoutId || '').first();
  if (!checkout) return false;
  if (checkout.billing_mode !== env.DODO_MODE || checkout.product_id !== env.DODO_PRODUCT_ID) return false;
  const customerId = subscription.customer?.customer_id;
  const next = Date.parse(subscription.next_billing_date);
  if (!customerId || !subscription.subscription_id || !Number.isFinite(next)) throw new Error('Incomplete subscription response');
  const validUntil = next + DAY; // One day renewal delivery grace; on_hold/failed still revoke immediately.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO billing_subscriptions (id, checkout_id, sender_id, customer_id, status, valid_until, event_at, billing_mode, product_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      status = excluded.status, valid_until = excluded.valid_until, event_at = excluded.event_at
      WHERE excluded.event_at >= billing_subscriptions.event_at`)
      .bind(subscription.subscription_id, checkout.id, checkout.sender_id, customerId, subscription.status, validUntil, eventAt, env.DODO_MODE, subscription.product_id),
    env.DB.prepare(`UPDATE devices SET plan = CASE WHEN EXISTS
      (SELECT 1 FROM billing_subscriptions WHERE sender_id = devices.id AND status = 'active' AND valid_until > ? AND billing_mode = ? AND product_id = ?)
      THEN 'pro' ELSE 'free' END WHERE id = (SELECT sender_id FROM billing_subscriptions WHERE id = ?)`)
      .bind(Date.now(), env.DODO_MODE, env.DODO_PRODUCT_ID, subscription.subscription_id),
    env.DB.prepare('INSERT OR IGNORE INTO billing_events (id, processed_at) VALUES (?, ?)').bind(eventId, Date.now())
  ]);
  await env.DB.prepare('DELETE FROM billing_checkout_locks WHERE checkout_id = ?').bind(checkout.id).run();
  return true;
}

export async function webhook(request, env) {
  if (!billingConfigured(env)) return fail('Billing is not configured', 503);
  if (Number(request.headers.get('content-length')) > 100000) return fail('Webhook too large', 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 100000) return fail('Webhook too large', 413);
  if (!await verifyWebhook(request, raw, env.DODO_WEBHOOK_SECRET)) return fail('Invalid webhook signature', 401);
  const event = JSON.parse(raw);
  const id = request.headers.get('webhook-id');
  if (await env.DB.prepare('SELECT id FROM billing_events WHERE id = ?').bind(id).first()) return json({ received: true });
  if (!String(event.type).startsWith('subscription.') || !event.data?.subscription_id) return json({ received: true, ignored: true });
  // Re-fetch current state: a late active webhook must never resurrect a cancelled subscription.
  const current = await dodo(env, `/subscriptions/${encodeURIComponent(event.data.subscription_id)}`);
  if (!Number.isFinite(Date.parse(event.timestamp))) return fail('Invalid event timestamp');
  // Order observations of current provider state, not possibly delayed event timestamps.
  await applySubscription(env, current, id, Date.now());
  return json({ received: true });
}

export async function checkout(request, env, device) {
  if (device?.platform !== 'chrome-extension') return fail('Unauthorized', 401);
  if (!billingConfigured(env)) return fail('Pro checkout is not available yet. Please try again later.', 503);
  const existing = await env.DB.prepare(`SELECT id FROM billing_subscriptions WHERE sender_id = ?
    AND billing_mode = ? AND product_id = ? AND status IN ('active', 'on_hold', 'paused', 'past_due', 'pending') LIMIT 1`)
    .bind(device.id, env.DODO_MODE, env.DODO_PRODUCT_ID).first();
  if (existing) return fail('You already have a subscription. Use Manage subscription.', 409);
  const body = await request.json();
  const recoveryKey = String(body.recoveryKey || '');
  if (!/^[a-f0-9]{64}$/.test(recoveryKey)) return fail('Save your recovery key before checkout.');
  const recoveryHash = await sha256(recoveryKey);
  let row = await env.DB.prepare('SELECT * FROM billing_checkouts WHERE recovery_hash = ?').bind(recoveryHash).first();
  if (row && row.sender_id !== device.id) return fail('Recovery key belongs to another installation', 403);
  if (row && (row.billing_mode !== env.DODO_MODE || row.product_id !== env.DODO_PRODUCT_ID)) {
    return fail('This recovery key belongs to a different payment environment or product. Keep it saved and create a new key for this checkout.', 409);
  }
  const pending = await env.DB.prepare('SELECT checkout_id FROM billing_checkout_locks WHERE sender_id = ?').bind(device.id).first();
  if (pending && pending.checkout_id !== row?.id) return fail('An earlier checkout is still pending. Use its saved recovery key; contact support if it expired.', 409);
  if (row?.checkout_url && row.created_at > Date.now() - DAY) return json({ checkoutUrl: row.checkout_url });
  if (row?.session_id) return fail('Checkout is pending or expired. Do not pay again; contact support to safely reset it.', 409);
  if (!row) {
    row = { id: crypto.randomUUID(), sender_id: device.id };
    await env.DB.prepare('INSERT OR IGNORE INTO billing_checkouts (id, sender_id, recovery_hash, created_at, billing_mode, product_id) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(row.id, device.id, recoveryHash, Date.now(), env.DODO_MODE, env.DODO_PRODUCT_ID).run();
    row = await env.DB.prepare('SELECT * FROM billing_checkouts WHERE recovery_hash = ?').bind(recoveryHash).first();
  }
  if (row.sender_id !== device.id) return fail('Recovery key belongs to another installation', 403);
  await env.DB.prepare('INSERT OR IGNORE INTO billing_checkout_locks (sender_id, checkout_id) VALUES (?, ?)').bind(device.id, row.id).run();
  const lock = await env.DB.prepare('SELECT checkout_id FROM billing_checkout_locks WHERE sender_id = ?').bind(device.id).first();
  if (lock.checkout_id !== row.id) return fail('Another checkout is pending. Use its saved recovery key.', 409);
  const claimed = await env.DB.prepare("UPDATE billing_checkouts SET session_id = 'creating' WHERE id = ? AND session_id IS NULL").bind(row.id).run();
  if (!claimed.meta.changes) return fail('Checkout is already being created. Wait a moment and try again.', 409);
  // A timeout is ambiguous: retain the lock rather than risk charging twice.
  const session = await dodo(env, '/checkouts', 'POST', {
    product_cart: [{ product_id: env.DODO_PRODUCT_ID, quantity: 1 }],
    metadata: { cachetray_checkout_id: row.id },
    return_url: `${env.WEB_ORIGIN}/billing-return.html`,
    customization: { theme: 'dark' }
  });
  if (!session.checkout_url?.startsWith('https://')) throw new Error('Checkout did not return a secure URL');
  await env.DB.prepare('UPDATE billing_checkouts SET session_id = ?, checkout_url = ? WHERE id = ?')
    .bind(session.session_id, session.checkout_url, row.id).run();
  return json({ checkoutUrl: session.checkout_url });
}

export async function portal(env, device) {
  if (device?.platform !== 'chrome-extension') return fail('Unauthorized', 401);
  const row = await env.DB.prepare('SELECT customer_id FROM billing_subscriptions WHERE sender_id = ? AND billing_mode = ? AND product_id = ? ORDER BY event_at DESC LIMIT 1')
    .bind(device.id, env.DODO_MODE, env.DODO_PRODUCT_ID).first();
  if (!row) return fail('No subscription found', 404);
  const session = await dodo(env, `/customers/${encodeURIComponent(row.customer_id)}/customer-portal/session?send_email=false&return_url=${encodeURIComponent(env.WEB_ORIGIN + '/billing-return.html')}`, 'POST');
  if (!session.link?.startsWith('https://')) throw new Error('Portal did not return a secure URL');
  return json({ portalUrl: session.link });
}

export async function restore(request, env, device) {
  if (device?.platform !== 'chrome-extension') return fail('Unauthorized', 401);
  const key = String((await request.json()).recoveryKey || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(key)) return fail('Enter your saved recovery key');
  const row = await env.DB.prepare(`SELECT s.id, s.sender_id, s.checkout_id, s.billing_mode, s.product_id FROM billing_subscriptions s
    JOIN billing_checkouts c ON c.id = s.checkout_id WHERE c.recovery_hash = ?`).bind(await sha256(key)).first();
  if (!row) return fail('No paid subscription found for this key', 404);
  if (row.billing_mode !== env.DODO_MODE || row.product_id !== env.DODO_PRODUCT_ID) return fail('This subscription belongs to a different payment environment or product.', 409);
  const other = await env.DB.prepare('SELECT id FROM billing_subscriptions WHERE sender_id = ? AND id != ? AND billing_mode = ? AND product_id = ?')
    .bind(device.id, row.id, env.DODO_MODE, env.DODO_PRODUCT_ID).first();
  if (other) return fail('This installation already has another subscription. Contact support.', 409);
  const current = await dodo(env, `/subscriptions/${encodeURIComponent(row.id)}`);
  if (!await applySubscription(env, current, `restore:${crypto.randomUUID()}`, Date.now())) return fail('Subscription does not match the configured Pro product', 409);
  await env.DB.batch([
    env.DB.prepare('UPDATE billing_subscriptions SET sender_id = ? WHERE id = ?').bind(device.id, row.id),
    env.DB.prepare('UPDATE billing_checkouts SET sender_id = ? WHERE id = ?').bind(device.id, row.checkout_id),
    env.DB.prepare(`UPDATE devices SET plan = CASE WHEN EXISTS
      (SELECT 1 FROM billing_subscriptions WHERE sender_id = devices.id AND status = 'active' AND valid_until > ? AND billing_mode = ? AND product_id = ?)
      THEN 'pro' ELSE 'free' END WHERE id IN (?, ?)`)
      .bind(Date.now(), env.DODO_MODE, env.DODO_PRODUCT_ID, row.sender_id, device.id)
  ]);
  return json({ restored: true });
}
