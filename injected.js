(function () {
  'use strict';

  if (window.__quicknotesInjectedLoaded) return;
  window.__quicknotesInjectedLoaded = true;

  const MESSAGE_SOURCE = '__quicknotes_injected';

  // Suppress clipboard captures that fire within 800ms of a double-click.
  // Some sites call clipboard.write on dblclick (image tap-to-copy), which would
  // silently save images the user didn't intend to copy.
  let lastDblClick = 0;
  document.addEventListener('dblclick', () => { lastDblClick = Date.now(); }, true);

  function isDoubleClickCapture() {
    return Date.now() - lastDblClick < 800;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        if (typeof dataUrl === 'string') resolve(dataUrl);
        else reject(new Error('FileReader did not produce a string'));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function postToContentScript(payload) {
    try {
      window.postMessage({ source: MESSAGE_SOURCE, payload }, '*');
    } catch (error) {
      // ignore
    }
  }

  if (!navigator.clipboard) return;

  if (typeof navigator.clipboard.writeText === 'function') {
    const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async function (text) {
      if (!isDoubleClickCapture() && typeof text === 'string' && text.trim()) {
        postToContentScript({ type: 'COPIED_TEXT', text: text.trim() });
      }
      return originalWriteText(text);
    };
  }

  if (typeof navigator.clipboard.write === 'function') {
    const originalWrite = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = async function (clipboardItems) {
      if (!isDoubleClickCapture() && Array.isArray(clipboardItems)) {
        for (const item of clipboardItems) {
          if (!item || typeof item.getType !== 'function') continue;
          const types = item.types || [];

          for (const mime of types) {
            if (!String(mime).startsWith('image/')) continue;
            try {
              const blob = await item.getType(mime);
              if (!blob || blob.size === 0) continue;
              const dataUrl = await blobToBase64(blob);
              postToContentScript({
                type: 'COPIED_IMAGE',
                image: dataUrl,
                mime
              });
            } catch (error) {
              // ignore
            }
            break;
          }

          if (types.includes('text/plain')) {
            try {
              const blob = await item.getType('text/plain');
              const text = await blob.text();
              if (text && text.trim()) {
                postToContentScript({
                  type: 'COPIED_TEXT',
                  text: text.trim()
                });
              }
            } catch (error) {
              // ignore
            }
          }
        }
      }

      return originalWrite(clipboardItems);
    };
  }
})();
