(function () {
  'use strict';
  const version = chrome.runtime.getManifest().version;
  const byId = id => document.getElementById(id);
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
  overlay.id = 'billingModal';
  overlay.innerHTML = `<div class="modal billing-modal billing-compact" role="dialog" aria-modal="true" aria-labelledby="billingTitle">
    <div class="billing-heading"><div class="modal-title" id="billingTitle">CacheTray Pro</div><button id="billingClose" type="button" class="modal-btn cancel">Close</button></div>
    <div class="billing-scroll">
    <div class="billing-price"><strong>$4.99</strong><span>/ month USD</span></div>
    <p class="billing-price-note">More room for your phone · plus applicable taxes</p>
    <p id="billingPlanSummary" class="billing-summary" role="status">Checking your plan…</p>
    <table class="billing-comparison" aria-label="Free and Pro phone limits"><thead><tr><th scope="col">On your phone</th><th scope="col">Free</th><th scope="col">Pro</th></tr></thead><tbody>
      <tr><th scope="row">Images</th><td><b>5</b><small>sends / 24h</small></td><td><b id="billingProImages">50</b><small>stored / phone</small></td></tr>
      <tr><th scope="row">Clips</th><td><b>20</b><small>per category</small></td><td><b id="billingProClips">100</b><small>per category</small></td></tr>
      <tr><th scope="row">Phones</th><td><b>1</b></td><td><b id="billingProPhones">2</b></td></tr>
    </tbody></table>
    <div id="billingRecovery" class="billing-recovery-card" hidden><details><summary>Save your recovery key</summary><label for="billingRecoveryKey">Your private key</label>
      <input id="billingRecoveryKey" class="phone-pair-input" readonly>
      <p class="billing-price-note">Keep it private. Use it to restore Pro after reinstalling.</p>
      <div class="billing-key-actions"><button id="copyRecovery" type="button" class="modal-btn">Copy key</button>
      <button id="newRecovery" type="button" class="modal-btn">New key</button></div></details>
      <label id="billingSavedLabel" class="billing-saved"><input id="recoverySaved" type="checkbox"> I saved my recovery key</label></div>
    <details class="billing-fine-print"><summary>How the limits work</summary><ul><li>Phone images and clips expire after 24 hours on both plans.</li><li>Free sends renew one by one after 24 hours. Deleting images does not reset sends.</li><li>Pro has no daily send cap. Deleting or expiring an image frees a storage slot.</li><li>Clips are text, links, code and tasks. Each category has its own limit.</li><li>Cancel through Manage subscription. Local extension storage is separate.</li></ul></details>
    <details class="billing-restore"><summary>Restore a paid subscription</summary>
      <label for="restoreRecovery">Saved recovery key</label><input id="restoreRecovery" class="phone-pair-input" autocomplete="off" spellcheck="false" maxlength="64">
      <button id="billingRestore" type="button" class="modal-btn">Restore Pro</button></details>
    <p id="billingError" class="phone-transfer-error" role="alert"></p>
    </div><div class="billing-footer"><button id="billingCheckout" type="button" class="modal-btn cloud-primary" disabled>Upgrade · $4.99/month</button>
    <button id="billingPortal" type="button" class="modal-btn" hidden>Manage subscription</button></div></div>`;
  document.body.appendChild(overlay);
  const news = document.createElement('div'); news.className = 'modal-overlay';
  news.innerHTML = `<div class="modal billing-modal release-modal" role="dialog" aria-modal="true" aria-labelledby="newsTitle">
    <div class="release-version">WHAT’S NEW · ${version}</div>
    <div class="modal-title" id="newsTitle">Your clipboard. Now on your phone.</div>
    <div class="release-features">
      <div class="release-feature"><span class="release-icon" aria-hidden="true">▧</span><div><strong>See it. Share it.</strong><p>Send an image, preview it, then share or download on your phone.</p></div></div>
      <div class="release-feature"><span class="release-icon" aria-hidden="true">⇄</span><div><strong>Pick up where you left off</strong><p>Your text, links, code &amp; tasks sync into easy-to-find categories.</p></div></div>
      <div class="release-feature"><span class="release-icon" aria-hidden="true">⌁</span><div><strong>Pair once. Keep going.</strong><p>Scan a QR to connect. See which images you’ve already sent.</p></div></div>
    </div>
    <div class="release-pro"><strong>More room with Pro <span>$4.99/month</span></strong><div class="release-stats"><span><b>50</b>images / phone</span><span><b>100</b>clips / category</span><span><b>2</b>paired phones</span></div></div>
    <details class="release-details"><summary>Free limits &amp; phone app</summary><p>Free: 5 image sends per rolling 24 hours, 20 clips per category &amp; 1 phone. Deleting images doesn’t reset sends.</p><p>Phone content expires after 24 hours on both plans. Your local extension clips are separate.</p><p>Install the phone app at <a href="https://cachetray.gitflex.lol/received.html#install" target="_blank" rel="noopener noreferrer">cachetray.gitflex.lol ↗</a>. Pro price is USD, plus applicable taxes.</p></details>
    <div class="modal-actions"><button id="newsClose" type="button" class="modal-btn">Got it</button></div></div>`;
  document.body.appendChild(news);
  const bar = document.querySelector('.app-bar-right');
  const planButton = byId('goProBtn') || document.createElement('button'); planButton.type = 'button';
  planButton.className = 'billing-plan-button'; planButton.textContent = 'Checking…'; planButton.title = 'CacheTray Pro · $4.99/month';
  const newsButton = document.createElement('button'); newsButton.type = 'button';
  newsButton.className = 'billing-news-button icon-action'; newsButton.title = 'What’s new'; newsButton.setAttribute('aria-label', 'What’s new');
  newsButton.textContent = '✦';
  if (!planButton.parentElement) bar?.append(planButton);
  bar?.append(newsButton);
  let account = null;
  let busy = false;
  async function call(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || 'Could not load billing');
    return result;
  }
  function render() {
    const pro = account?.plan === 'pro';
    const available = account?.billing?.available === true;
    byId('billingPlanSummary').textContent = pro
      ? `Pro active ✓ · ${account?.usage?.imagesUsed || 0} images available`
      : `Free · ${account?.usage?.imagesSentLast24h || 0}/5 sends used`;
    const cap = account?.limits;
    byId('billingProImages').textContent = String(pro && cap ? cap.imagesPerPhone : 50);
    byId('billingProClips').textContent = String(pro && cap ? cap.clipsPerCategory : 100);
    byId('billingProPhones').textContent = String(pro && cap ? cap.phones : 2);
    byId('billingSavedLabel').hidden = pro || account?.billing?.subscribed === true;
    byId('billingRecovery').hidden = !available && !account?.billing?.subscribed;
    byId('newRecovery').hidden = account?.billing?.subscribed === true;
    byId('billingCheckout').hidden = account?.billing?.subscribed === true || pro;
    byId('billingCheckout').textContent = available ? 'Upgrade · $4.99/month' : 'Pro checkout coming soon';
    byId('billingCheckout').disabled = busy || !available || !byId('recoverySaved').checked;
    byId('billingPortal').hidden = !account?.billing?.hasSubscription;
    planButton.textContent = pro ? 'Pro ✓' : 'Go Pro';
  }
  async function load(newKey = false) {
    const result = await call({ type: 'BILLING_PREPARE', newKey });
    account = result.account;
    byId('billingRecoveryKey').value = result.recoveryKey;
    render();
  }
  async function open() {
    overlay.classList.add('open'); byId('billingError').textContent = '';
    try { await load(); } catch (error) { byId('billingError').textContent = error.message; }
    byId('billingClose').focus();
  }
  const close = () => { overlay.classList.remove('open'); planButton.focus(); };
  planButton.onclick = open;
  byId('billingClose').onclick = close;
  overlay.onclick = event => { if (event.target === overlay) close(); };
  byId('recoverySaved').onchange = render;
  byId('copyRecovery').onclick = async () => {
    try {
      await navigator.clipboard.writeText(byId('billingRecoveryKey').value);
      byId('copyRecovery').textContent = 'Copied ✓';
      setTimeout(() => { byId('copyRecovery').textContent = 'Copy key'; }, 2000);
    } catch (_) { byId('billingError').textContent = 'Select the recovery key and copy it manually.'; }
  };
  byId('newRecovery').onclick = async () => {
    if (!confirm('Replace the key for a new checkout? Keep any earlier key until you know that checkout was not paid.')) return;
    byId('recoverySaved').checked = false;
    try { await load(true); } catch (error) { byId('billingError').textContent = error.message; }
  };
  async function action(name, button) {
    if (busy) return;
    busy = true; button.disabled = true; byId('billingError').textContent = '';
    try {
      await call({ type: 'BILLING_ACTION', action: name, recoveryKey: byId('restoreRecovery').value });
      if (name === 'restore') { await load(); byId('billingError').textContent = 'Subscription restored.'; }
      else byId('billingError').textContent = 'Opened in a browser tab. Your plan updates after payment is verified.';
    } catch (error) { byId('billingError').textContent = error.message; }
    finally { busy = false; button.disabled = false; render(); }
  }
  byId('billingCheckout').onclick = () => action('checkout', byId('billingCheckout'));
  byId('billingPortal').onclick = () => action('portal', byId('billingPortal'));
  byId('billingRestore').onclick = () => action('restore', byId('billingRestore'));
  newsButton.onclick = () => { news.classList.add('open'); byId('newsClose').focus(); };
  byId('newsClose').onclick = async () => {
    news.classList.remove('open'); newsButton.classList.remove('has-update');
    await chrome.storage.local.set({ ct_release_seen: version });
    await chrome.storage.local.remove('ct_release_pending');
    newsButton.focus();
  };
  news.onclick = event => { if (event.target === news) byId('newsClose').click(); };
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { if (overlay.classList.contains('open')) close(); if (news.classList.contains('open')) byId('newsClose').click(); }
  });
  chrome.storage.local.get(['ct_release_pending', 'ct_release_seen']).then(stored => {
    if (stored.ct_release_pending === version && stored.ct_release_seen !== version) {
      newsButton.classList.add('has-update'); newsButton.title = `Updated to ${version} · What’s new`;
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.ct_phone_plan_v1?.newValue) {
      account = changes.ct_phone_plan_v1.newValue;
      render();
    }
  });
  // A new popup must load its plan, not reset a paid user to the default label.
  // Cached state is display-only; the Worker still authorizes every paid action.
  chrome.storage.local.get('ct_phone_plan_v1').then(stored => {
    if (!account && stored.ct_phone_plan_v1) { account = stored.ct_phone_plan_v1; render(); }
    return call({ type: 'TRANSFER_DEVICES' });
  }).then(result => {
    if (result.account) { account = result.account; render(); }
    else if (!account && result.configured === false) { account = { plan: 'free' }; render(); }
  }).catch(() => { /* A failed check must not replace a known plan with Free. */ });
  globalThis.CacheTrayBillingUI = { open };
})();
