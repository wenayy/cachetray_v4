const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(available = false, cached = null, authoritative = null) {
  const nodes = new Map(), messages = [], timers = [];
  const state = { account: { plan: 'free', limits: { imagesPerPhone: 5, clipsPerCategory: 20, phones: 1 }, usage: { imagesUsed: 2 }, billing: { available } } };
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { children: [], value: '', checked: false, hidden: false, disabled: false,
        classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) },
        setAttribute() {}, focus() {}, click() { return this.onclick?.(); },
        append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); } });
    }
    return nodes.get(id);
  };
  const context = {
    document: { getElementById: node, createElement: () => node(Symbol()), body: node('body'), querySelector: () => node('bar'), addEventListener() {} },
    navigator: { clipboard: { async writeText(value) { state.copied = value; } } },
    setTimeout: callback => timers.push(callback), confirm: () => true,
    chrome: { runtime: { getManifest: () => ({ version: '1.6.0' }), async sendMessage(message) {
      messages.push(message);
      if (message.type === 'TRANSFER_DEVICES') return { ok: true, account: authoritative };
      return message.type === 'BILLING_PREPARE' ? { ok: true, recoveryKey: 'a'.repeat(64), account: state.account } : { ok: true };
    } }, storage: { local: { async get() { return { ct_release_pending: '1.6.0', ct_phone_plan_v1: cached }; }, async set() {}, async remove() {} }, onChanged: { addListener(callback) { state.changed = callback; } } } }
  };
  vm.runInNewContext(fs.readFileSync('billing-ui.js', 'utf8'), context);
  return { node, context, state, messages, timers };
}

test('billing UI requires configured checkout and a saved key; copy feedback and news work', async () => {
  const h = harness(false);
  await h.context.CacheTrayBillingUI.open();
  assert.equal(h.node('billingCheckout').disabled, true);
  assert.equal(h.node('billingCheckout').textContent, 'Pro checkout coming soon');
  h.state.account.billing.available = true;
  await h.context.CacheTrayBillingUI.open();
  assert.equal(h.node('billingCheckout').disabled, true);
  h.node('recoverySaved').checked = true;
  h.node('recoverySaved').onchange();
  assert.equal(h.node('billingCheckout').disabled, false);
  await h.node('copyRecovery').onclick();
  assert.equal(h.state.copied, 'a'.repeat(64));
  assert.equal(h.node('copyRecovery').textContent, 'Copied ✓');
  await h.node('billingCheckout').onclick();
  assert.ok(h.messages.some(message => message.type === 'BILLING_ACTION' && message.action === 'checkout'));
  const news = h.node('bar').children[1];
  assert.ok(news.classList.contains('has-update'));
  news.onclick();
  await h.node('newsClose').onclick();
  assert.equal(news.classList.contains('has-update'), false);
});

test('new popup loads saved Pro and does not downgrade on an unavailable account response', async () => {
  const h = harness(true, { plan: 'pro', billing: { available: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.node('goProBtn').textContent, 'Pro ✓');
  assert.ok(h.messages.some(message => message.type === 'TRANSFER_DEVICES'));
});

test('authoritative current plan replaces cached state, including a real downgrade', async () => {
  const h = harness(true, { plan: 'pro' }, { plan: 'free', billing: { available: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.node('goProBtn').textContent, 'Go Pro');
  h.state.changed({ ct_phone_plan_v1: { newValue: { plan: 'pro' } } }, 'local');
  assert.equal(h.node('goProBtn').textContent, 'Pro ✓');
});

test('release notes use three short feature cards with expandable details', () => {
  const h = harness();
  const html = h.node('body').children[1].innerHTML;
  assert.equal((html.match(/class="release-feature"/g) || []).length, 3);
  assert.match(html, /<details class="release-details">/);
  assert.match(html, /<b>50<\/b>/);
  assert.doesNotMatch(html, /<ul class="release-notes">/);
});

test('verified Pro status shows configured benefits and subscription management', async () => {
  const h = harness(true);
  h.state.account = { plan: 'pro', limits: { imagesPerPhone: 50, clipsPerCategory: 100, phones: 2 }, usage: { imagesUsed: 10 }, billing: { available: true, subscribed: true, hasSubscription: true } };
  await h.context.CacheTrayBillingUI.open();
  assert.equal(h.node('billingProImages').textContent, '50');
  assert.equal(h.node('billingProClips').textContent, '100');
  assert.equal(h.node('billingProPhones').textContent, '2');
  assert.equal(h.node('billingSavedLabel').hidden, true);
  assert.equal(h.node('billingCheckout').hidden, true);
  assert.equal(h.node('billingPortal').hidden, false);
  assert.equal(h.node('newRecovery').hidden, true);
  await h.node('billingPortal').onclick();
  assert.ok(h.messages.some(message => message.action === 'portal'));
});

test('Pro panel presents a compact comparison and keeps detailed rules expandable', () => {
  const h = harness();
  const html = h.node('body').children[0].innerHTML;
  assert.match(html, /<table class="billing-comparison"/);
  assert.match(html, /sends \/ 24h/);
  assert.match(html, /stored \/ phone/);
  assert.match(html, /<details class="billing-fine-print">/);
  assert.match(html, /class="billing-footer"/);
  assert.doesNotMatch(html, /class="billing-benefits"/);
});
