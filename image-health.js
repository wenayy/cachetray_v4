(function () {
  'use strict';
  const button = document.getElementById('check');
  const summary = document.getElementById('summary');
  const results = document.getElementById('results');
  const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;

  button.onclick = async () => {
    button.disabled = true;
    results.replaceChildren();
    summary.textContent = 'Checking local image references…';
    try {
      const stored = await chrome.storage.local.get(CT.STORAGE_KEY);
      const data = stored[CT.STORAGE_KEY];
      const images = Object.entries(data?.clusters || {}).flatMap(([workspace, cluster]) =>
        (cluster.notes || []).filter(note => note.type === 'image').map(note => ({ workspace, note })));
      let available = 0, missing = 0, inline = 0, external = 0, readErrors = 0;
      for (const [index, { workspace, note }] of images.entries()) {
        let state;
        if (note.imageId != null) {
          const blob = await CT.imgDbGetRetry(note.imageId);
          if (blob instanceof Blob && blob.size > 0) state = 'available';
          else if (note.dataUrl?.startsWith('data:image/')) state = 'inline';
          else {
            try { await CT.imgDbGet(note.imageId); state = 'missing'; }
            catch (_) { state = 'read-error'; }
          }
        } else if (note.dataUrl?.startsWith('data:image/')) state = 'inline';
        else if (note.imageUrl) state = 'external';
        else state = 'missing';
        if (state === 'available') available += 1;
        else if (state === 'inline') inline += 1;
        else if (state === 'external') external += 1;
        else if (state === 'read-error') readErrors += 1;
        else missing += 1;
        if (state === 'missing' || state === 'read-error') {
          const row = document.createElement('li'); row.className = 'missing';
          row.textContent = `${note.content || 'Untitled image'} · ${workspace}`;
          const detail = document.createElement('small');
          detail.textContent = `${state === 'read-error' ? 'Read error · ' : ''}Saved ${note.time ? new Date(note.time).toLocaleString() : 'at unknown time'} · image ID ${note.imageId ?? 'none'}`;
          row.append(detail); results.append(row);
        }
        if (index % 10 === 0) summary.textContent = `Checked ${index + 1} of ${images.length} images…`;
      }
      const metadataBytes = await chrome.storage.local.getBytesInUse(CT.STORAGE_KEY);
      const estimate = await navigator.storage?.estimate?.().catch(() => null);
      summary.textContent = `${available} available in IndexedDB · ${inline} stored inline · ${external} external links · ${missing} missing · ${readErrors} read errors\n` +
        `CacheTray metadata: ${mb(metadataBytes)}${estimate?.usage ? ` · Extension origin storage use (estimate): ${mb(estimate.usage)}` : ''}` +
        (missing ? '\nMissing files cannot be restored by this check. Do not clear Chrome or extension data. If a copy is still on your phone, download it there.' : '');
      if (!images.length) summary.textContent = 'No image notes found.';
    } catch (error) {
      summary.textContent = `Check failed: ${error.message || error}`;
    } finally { button.disabled = false; }
  };
  button.click();
})();
