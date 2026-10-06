# CacheTray image storage: safe recovery check

CacheTray images are local to the Chrome profile: note metadata is in `chrome.storage.local`, and compressed image Blobs are in the extension's IndexedDB. Send to Phone is temporary transfer storage, not a backup.

1. **Free several GB on the Mac's internal disk first.** A connected external SSD does not automatically move Chrome's profile or IndexedDB there. Do not delete the Chrome profile, uninstall CacheTray, clear site/extension data, or reset IndexedDB.
2. Reload CacheTray in `chrome://extensions`, open the extension, and select **Check images** in its footer. The new page only reads the current data.
3. If an image is **available in IndexedDB** but its thumbnail is blank, report that result: the Blob may still be recoverable and the rendering path needs further attention.
4. If an image is **stored inline**, it is still in CacheTray metadata and should display even if the IndexedDB reference failed.
5. If an image is **missing**, the note remains but its Blob is absent. This update cannot reconstruct its pixels. Re-copy the original if you still have it. If you sent it to the phone and it is still within the 24-hour transfer window, download it there. A Mac/Chrome profile backup may also contain the older Blob.
6. Keep important images outside the three-day temporary tray as an additional backup, for example by downloading them to the external SSD.

The update prevents future image IDs from being published before their IndexedDB transaction commits, removes deletion-before-save, and requests `unlimitedStorage`. It cannot overcome a physically full drive or guarantee recovery of files already removed.
