# Send to Phone MVP

This feature is separate from the existing Firebase sync preview. Image Blobs stay in CacheTray's local IndexedDB. The extension uploads **only a clicked image** directly to private R2 via a five-minute presigned PUT URL. The Worker stores metadata in D1 and verifies the uploaded object's size and MIME type before the phone sees it. The phone polls every 2.5 seconds while its inbox is open. Transfers are visible for 24 hours. There is no native app, push notification, or automatic background delivery yet.

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

1. Open `https://YOUR_WEBSITE_DOMAIN/received.html` on Android and use **Add to Home screen / Install app**. Open it and create an inbox such as `Pixel 8`.
2. The phone displays a three word pairing phrase. On the Mac, open an image **already saved in CacheTray**, click **Send to Phone**, type those words, and pair. The image then uploads automatically. If the phrase has expired, tap **Generate new code** on the phone. Existing older 20-character codes still work, or you can generate a new phrase.
3. For later images, click **Send to Phone** again. With one paired device, it immediately shows **Uploading…** then **Sent ✓**. With multiple paired devices, select the destination.
4. Keep the phone's **Received** page open. Within about three seconds, the image should appear without a page refresh. Tap its thumbnail to preview it, switch between **Grid** and **List**, use **Share** to send the image file through Android's share sheet, or tap **Download** to save a copy. In List, swipe left (or tap ⋯) to reveal **Delete**; in Grid, tap ⋯ then **Delete image**. Delete removes that transfer record and its temporary R2 object, but never the original image on the Mac. Download does not automatically add to Android Gallery.

## Reliability and privacy notes

- The original IndexedDB Blob is never deleted or converted to base64. A failed transfer leaves the original intact and shows an error/retry button.
- “Sent ✓” means R2 accepted the exact Blob and the Worker confirmed the R2 object exists with the expected size and MIME type. It does **not** mean the phone has downloaded it.
- Each phone stores a private device token in browser local storage; each Mac pairing stores a sender token in extension local storage. Pairing phrases are single-use, expire in 10 minutes, and are stored hashed in D1. The API also limits pairing guesses per IP address. Use a strong HTTPS site and avoid clearing browser site data if you want the pairing to persist.
- The R2 bucket is private. The API issues 60-second presigned GET URLs only to the paired receiving phone. Anyone holding a URL during those 60 seconds can use it, so do not share it. The first version is not end-to-end encrypted.
- Max image size is 20 MB; PNG, JPEG, WebP, and GIF are supported. SVG is intentionally excluded. An uploading record never appears in the phone inbox until the ready verification succeeds.
- D1 records currently remain after expiry but are filtered from the inbox. Add a scheduled metadata cleanup before heavy production use. The live `cachetray-transfers` R2 bucket has a `CacheTrayTransferExpiry` rule for the `transfers/` prefix that expires objects after one day; Cloudflare removes them asynchronously, so physical deletion may occur later than the 24-hour point.

## Phase 2 (not implemented)

Web Push / FCM when the PWA is closed; background receiving; local IndexedDB copies on Android; optional native Android app; automatic Gallery saving; text/link/file transfer; download acknowledgements; end-to-end encryption; account-backed device management.
