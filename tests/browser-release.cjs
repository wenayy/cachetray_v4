const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/vinay/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cachetray-browser-release-'));
const extension = path.join(stage, 'extension');
fs.mkdirSync(extension);
// Only runtime files; the test profile and its extension are independent of real Chrome data.
for (const name of fs.readdirSync(root)) {
  if (/\.(js|html|css|png|svg)$/.test(name) || name === 'manifest.json') fs.copyFileSync(path.join(root, name), path.join(extension, name));
}
fs.cpSync(path.join(root, 'images'), path.join(extension, 'images'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures/offscreen-disabled.js'), path.join(extension, 'offscreen.js'));

(async () => {
  const browser = await chromium.launchPersistentContext(path.join(stage, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const errors = [];
  browser.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const popup = await browser.newPage(), sidebar = await browser.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await sidebar.goto(`chrome-extension://${id}/sidebar.html`);
    await popup.locator('#feed .row').first().waitFor();
    await sidebar.locator('#feed .row').first().waitFor();
    for (const page of [popup, sidebar]) await page.evaluate(() => onboardDone());

    await Promise.all([
      popup.evaluate(() => addNote('saved from popup', 'text')),
      sidebar.evaluate(() => addNote('saved from sidebar', 'text'))
    ]);
    let stored = await worker.evaluate(async () => (await chrome.storage.local.get('quicknotes_v1')).quicknotes_v1);
    assert(stored.clusters.inbox.notes.some(n => n.content === 'saved from popup'));
    assert(stored.clusters.inbox.notes.some(n => n.content === 'saved from sidebar'));
    assert.equal(new Set(stored.clusters.inbox.notes.map(n => n.id)).size, stored.clusters.inbox.notes.length);

    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
    await worker.evaluate(() => {
      globalThis.__originalCompression = compressImageDataUrl;
      compressImageDataUrl = data => new Promise(resolve => { globalThis.__finishCompression = () => resolve(data); });
    });
    const capture = worker.evaluate(dataUrl => enqueueSave(() => addStoredNote('concurrent capture', { type: 'image', dataUrl })), image);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await worker.evaluate(() => Boolean(globalThis.__finishCompression))) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const edit = popup.evaluate(() => addNote('popup while image is saving', 'text'));
    await worker.evaluate(() => { globalThis.__finishCompression(); compressImageDataUrl = globalThis.__originalCompression; });
    await Promise.all([capture, edit]);
    stored = await worker.evaluate(async () => (await chrome.storage.local.get('quicknotes_v1')).quicknotes_v1);
    assert(stored.clusters.inbox.notes.some(n => n.content === 'concurrent capture' && n.imageId != null));
    assert(stored.clusters.inbox.notes.some(n => n.content === 'popup while image is saving'));
    const imageNote = stored.clusters.inbox.notes.find(n => n.content === 'concurrent capture');
    assert(await worker.evaluate(async id => Boolean(await CT.imgDbGetRetry(id)), imageNote.imageId));

    // Raw query markup must appear as text, without creating an image element.
    await popup.evaluate(() => { searchQuery = '<img src="https://example.invalid/review.png">'; renderFeed(); });
    assert.equal(await popup.locator('#feed img').count(), 0);
    assert((await popup.locator('#feed').innerText()).includes('<img src='));
    await popup.evaluate(() => { searchQuery = ''; renderFeed(); });

    const evilName = '<img src="https://example.invalid/workspace.png">';
    await popup.evaluate(name => { clusters[name] = { id: crypto.randomUUID(), color: 'red', notes: [{ id: crypto.randomUUID(), type: 'text', content: 'workspace search match', time: Date.now() }] }; return saveData(); }, evilName);
    await popup.evaluate(() => { searchAllWorkspaces = true; searchQuery = 'workspace search match'; renderFeed(); });
    assert.equal(await popup.locator('#feed .ws-badge img').count(), 0);
    assert((await popup.locator('#feed .ws-badge').innerText()).includes('<img src='));
    await popup.evaluate(() => { searchQuery = ''; searchAllWorkspaces = false; renderFeed(); });

    // UUID row selection and image delete/undo retain the Blob.
    await popup.evaluate(id => { current = 'inbox'; currentCat = 'image'; renderAll(); selectedIds.add(id); updateSelUI(); }, imageNote.id);
    assert.equal(await popup.locator('.row[data-note-id="' + imageNote.id + '"]').count(), 1);
    await popup.locator('.row[data-note-id="' + imageNote.id + '"] .row-title').click();
    assert.equal(await popup.evaluate(id => selectedIds.has(id), imageNote.id), false);
    await popup.evaluate(id => deleteNote(id), imageNote.id);
    await popup.evaluate(() => undoDelete());
    stored = await worker.evaluate(async () => (await chrome.storage.local.get('quicknotes_v1')).quicknotes_v1);
    assert(stored.clusters.inbox.notes.some(n => n.id === imageNote.id));
    assert(await worker.evaluate(async id => Boolean(await CT.imgDbGetRetry(id)), imageNote.imageId));

    // Load the actual content script into a controlled HTTP page, not a real website.
    await popup.evaluate(() => addNote('<b>plain clipboard text & symbols</b>', 'text'));
    const website = await browser.newPage();
    await website.route('https://capture-test.example/**', route => route.fulfill({ body: '<!doctype html><html><body><p id="selectable">Selection saved on Free</p><p id="paused">Paused selection must not save</p><textarea id="editor">Private editable selection</textarea><p id="synthetic">Synthetic selection must not save</p></body></html>', contentType: 'text/html' }));
    await website.goto('https://capture-test.example/');
    let contentLoaded = false;
    for (let attempt = 0; attempt < 100 && !contentLoaded; attempt++) {
      contentLoaded = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: 'https://capture-test.example/*' });
        const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => Boolean(window.__quicknotesContentLoaded) });
        return result.result;
      });
      if (!contentLoaded) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(contentLoaded, 'Content script did not load');
    // Substitute clipboard transport in the actual isolated content-script world,
    // so browser verification cannot overwrite the user's system clipboard.
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://capture-test.example/*' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        window.__selectionClipboard = 'original clipboard';
        Object.defineProperty(navigator, 'clipboard', { value: {
          writeText: async text => { window.__selectionClipboard = text; }
        }, configurable: true });
      } });
    });
    const clipboardValue = () => worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://capture-test.example/*' });
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__selectionClipboard });
      return result.result;
    });
    const before = await worker.evaluate(async () => JSON.stringify((await chrome.storage.local.get('quicknotes_v1')).quicknotes_v1));
    await website.evaluate(() => {
      window.postMessage({ source: '__quicknotes_injected', payload: { type: 'COPIED_TEXT', text: 'forged capture' } }, '*');
      document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true }));
      document.dispatchEvent(new ClipboardEvent('cut', { bubbles: true }));
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    const after = await worker.evaluate(async () => JSON.stringify((await chrome.storage.local.get('quicknotes_v1')).quicknotes_v1));
    assert.equal(after, before);
    // Trusted selection on a Free profile copies and saves once.
    await website.locator('#selectable').click({ clickCount: 3 });
    await website.waitForTimeout(600);
    let selectionNotes = await worker.evaluate(async () => Object.values((await chrome.storage.local.get('quicknotes_v1')).quicknotes_v1.clusters).flatMap(c => c.notes));
    assert.equal(selectionNotes.filter(n => n.content === 'Selection saved on Free').length, 1);
    assert.equal(await clipboardValue(), 'Selection saved on Free');
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://capture-test.example/*' });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__selectionClipboard = 'different clipboard'; } });
    });
    await website.locator('#selectable').click({ clickCount: 3 });
    await website.waitForTimeout(600);
    selectionNotes = await worker.evaluate(async () => Object.values((await chrome.storage.local.get('quicknotes_v1')).quicknotes_v1.clusters).flatMap(c => c.notes));
    assert.equal(selectionNotes.filter(n => n.content === 'Selection saved on Free').length, 1, 'Repeat selection must not create another clip');
    assert.equal(await clipboardValue(), 'Selection saved on Free', 'A saved selection must still be copied again');
    await worker.evaluate(() => chrome.storage.local.set({ qn_capture_enabled: false }));
    await website.locator('#paused').click({ clickCount: 3 });
    await website.waitForTimeout(600);
    assert.equal(await clipboardValue(), 'Selection saved on Free', 'Pause must also prevent clipboard replacement');
    await worker.evaluate(() => chrome.storage.local.set({ qn_capture_enabled: true }));
    await website.locator('#editor').click({ clickCount: 3 });
    await website.waitForTimeout(600);
    await website.evaluate(() => {
      const selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(document.getElementById('synthetic'));
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await website.waitForTimeout(600);
    selectionNotes = await worker.evaluate(async () => Object.values((await chrome.storage.local.get('quicknotes_v1')).quicknotes_v1.clusters).flatMap(c => c.notes));
    assert(!selectionNotes.some(n => /^(Paused selection|Private editable|Synthetic selection)/.test(n.content)));
    assert.equal(await clipboardValue(), 'Selection saved on Free', 'Editors and synthetic selection must not overwrite clipboard');
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://capture-test.example/*' });
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PALETTE' });
    });
    await website.getByPlaceholder('search tray…').fill('plain clipboard text');
    assert.equal(await website.locator('.ct-list b').count(), 0);
    assert.equal(await website.locator('.ct-list .ct-text').first().innerText(), '<b>plain clipboard text & symbols</b>');
    assert.equal(errors.length, 0, errors.join('\n'));
    await popup.screenshot({ path: path.join(stage, 'popup.png') });
    console.log(JSON.stringify({ result: 'passed', checks: ['popup/sidebar concurrent saves', 'image capture/save race', 'unique IDs', 'image Blob durability', 'search/workspace HTML safety', 'UUID selection', 'image undo', 'forged capture rejection', 'Free selection capture and deduplication', 'selection pause and editable-field exclusion', 'zero page errors'], stage }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
