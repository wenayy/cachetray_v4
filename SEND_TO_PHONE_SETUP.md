# Connect Phone MVP

This feature is separate from the existing Firebase sync preview. Scanning the extension's one-time QR code pairs a phone without an account and opts in to temporary sync of the last 24 hours of text, code, links, and tasks through the Cloudflare Worker and D1. Image Blobs stay in CacheTray's local IndexedDB. The extension uploads **only a clicked image** directly to private R2 via a five-minute presigned PUT URL. The Worker stores metadata in D1 and verifies the uploaded object's size and MIME type before the phone sees it. Image transfers are visible for 24 hours. There is no native app, push notification, or automatic background delivery yet.

## What to create in Cloudflare

Before these steps, install Node.js 22 or newer for the current Wrangler CLI. The Android side needs only Chrome; no Android SDK or native build is involved.

1. Create an R2 bucket named `cachetray-transfers`. Keep it private; do not enable public bucket access.
2. Create a D1 database named `cachetray-transfers` and put its database ID in `transfer-worker/wrangler.jsonc`.
3. Create an R2 API token scoped to **this bucket** with Object Read & Write. You need its Access Key ID and Secret Access Key for the Worker only. Never put them in the extension, website, or a message/chat.
4. In `transfer-worker/wrangler.jsonc`, set both `account_id` and `R2_ACCOUNT_ID`, `WEB_ORIGIN` to your exact HTTPS website origin, and `EXTENSION_ORIGIN` to `chrome-extension://` plus the ID shown at `chrome://extensions`. The unpacked extension ID may differ from your Web Store ID; use the one you are testing.
5. From `transfer-worker`, run:

   ```sh
   npm install
   npx wrangler login
   npx wrangler d1 migrations apply cachetray-transfers --remote
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   npm run deploy
   ```

   The two `secret put` commands prompt privately. Do not paste the secret key into a source file. Note the resulting HTTPS Worker URL.

6. Set that same Worker URL in both `transfer-config.js` (extension root) and `cachetraywebsite/transfer-config.js`. Reload the extension at `chrome://extensions`, then publish the updated `cachetraywebsite` directory to your HTTPS site. The phone must reach this public site; `localhost` on the Mac is not enough.
7. Add this R2 bucket CORS policy, replacing both origins with your actual values:

   ```json
   [{
     "AllowedOrigins": ["chrome-extension://YOUR_TEST_EXTENSION_ID", "https://YOUR_WEBSITE_DOMAIN"],
     "AllowedMethods": ["PUT", "GET"],
     "AllowedHeaders": ["Content-Type"],
     "ExposeHeaders": ["ETag"],
     "MaxAgeSeconds": 3600
   }]
   ```

   R2 CORS rules can take a short time to propagate. The Worker has a **separate** CORS allowlist from the R2 bucket; both must be correct.
8. In R2 bucket settings, add a lifecycle rule to delete objects after **1 day** (all objects in this dedicated transfer bucket). The API hides expired transfers at 24 hours; R2 lifecycle deletion itself can happen later, so do not treat it as exact-second deletion.

## Test on Mac and Android

1. On the Mac, open CacheTray and click the small **phone** icon, then **Show QR code**. On Android or iPhone, use the phone camera or the PWA's **Scan QR** button. The link opens the phone website and creates its inbox automatically. It is not necessary to install the PWA first. The QR is one-use and expires in 10 minutes.
2. The phone's **Recent clips** section shows text, links, code, and tasks added in the last 24 hours. New clips sync automatically when the extension changes; the open phone page refreshes that section roughly every 15 seconds. Only the newest 200 clips, up to 200 KB per upload, are included in this MVP. The local extension remains the source of truth.
3. If QR scanning is unavailable, open the website on your phone, create an inbox, tap **Use words**, then enter the three-word phrase in the extension's **Use a pairing phrase instead** section.
4. For images, open an image **already saved in CacheTray** and click **Send to Phone**. With one paired device it uploads immediately; with multiple devices select the destination. Keep the phone's **Received** page open. Within about three seconds, the image appears. Tap its thumbnail to preview, switch **Grid/List**, **Share**, or **Download**. In List, swipe left (or tap ⋯) to reveal **Delete**; in Grid, tap ⋯ then **Delete image**. Delete removes that transfer record and its temporary R2 object, never the original Mac image. Download does not automatically add to Android Gallery.
5. If you like the website experience, use Chrome's **Add to Home screen / Install app** on Android. This is optional; the same website works without installing it.
6. To stop syncing, click the phone icon in the Mac extension and choose **Disconnect** beside that phone. This removes the pairing and its D1 clip snapshot. Previously sent images remain available until their normal 24-hour expiry or you delete them on the phone.

The phone page offers one contextual **Install app** action: Android Chrome opens its install prompt when available, while iPhone users get Safari's Add to Home Screen instructions. The in-page QR scanner uses the vendored jsQR 1.4.0 library (`cachetraywebsite/vendor/jsQR.js`, Apache-2.0 license alongside it) and needs camera permission. You can still use the phone's Camera app or the three-word fallback.

**Device limits:** One paired phone per Mac is enforced for Free. The backend schema supports two for a server-assigned Pro entitlement, but Pro billing and self-service upgrades are **not** implemented. Do not advertise Pro as purchasable yet. The extension retains one Mac sender identity across disconnects; clearing extension storage can reset that identity, so a true per-customer entitlement will require accounts or another durable identity before launch.

## Reliability and privacy notes

- The original IndexedDB Blob is never deleted or converted to base64. A failed transfer leaves the original intact and shows an error/retry button.
- “Sent ✓” means R2 accepted the exact Blob and the Worker confirmed the R2 object exists with the expected size and MIME type. It does **not** mean the phone has downloaded it.
- Each phone stores a private device token in browser local storage; each Mac pairing stores a sender token in extension local storage. QR connection secrets and pairing phrases are single-use, expire in 10 minutes, and are stored hashed in D1. The API rate-limits creation and phrase guesses per IP address. Use a strong HTTPS site and avoid clearing browser site data if you want the pairing to persist. Without an account, lost devices cannot automatically recover their pairing.
- Pairing opts the Mac into sending recent non-image clips to D1. The Worker filters them to a 24-hour window, and an hourly scheduled cleanup removes expired clip snapshots. They are **not end-to-end encrypted**. The phone does not yet save clips locally for offline use. The older Firebase cloud-sync preview is inactive and no longer appears in the extension UI.
- The R2 bucket is private. The API issues 60-second presigned GET URLs only to the paired receiving phone. Anyone holding a URL during those 60 seconds can use it, so do not share it. The first version is not end-to-end encrypted.
- Max image size is 20 MB; PNG, JPEG, WebP, and GIF are supported. SVG is intentionally excluded. An uploading record never appears in the phone inbox until the ready verification succeeds.
- Expired image-transfer D1 records currently remain but are filtered from the inbox; scheduled cleanup covers only QR sessions and clip snapshots. Add image-transfer metadata cleanup before heavy production use. The live `cachetray-transfers` R2 bucket has a `CacheTrayTransferExpiry` rule for the `transfers/` prefix that expires objects after one day; Cloudflare removes them asynchronously, so physical deletion may occur later than the 24-hour point.

## Phase 2 (not implemented)

Web Push when the PWA is closed; background receiving; local IndexedDB copies on Android; optional TWA/native Android app; automatic Gallery saving; file transfer; download acknowledgements; end-to-end encryption; account-backed device recovery and billing/Plus entitlements.
