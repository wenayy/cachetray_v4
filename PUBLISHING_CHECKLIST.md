# CacheTray 1.7.5 release checklist

## Upload

- Upload `CacheTray-1.7.5.zip` as an update to the existing Chrome Web Store item. Do not create a new listing/extension ID unless intentional.
- For local testing, extract the ZIP and use Chrome's Developer mode → Load unpacked. Chrome does not load an unpacked extension directly from a ZIP.
- Publish the latest `cachetraywebsite` assets separately to Cloudflare Pages (`cachetray-web`). See `CLOUDFLARE_PAGES_SETUP.md` for updates and pending canonical-domain activation. The extension ZIP does not contain the phone website or Worker.
- Confirm `https://cachetray.gitflex.lol/billing-return.html`, `/received.html` and `/privacy.html` are accessible on the live site.

## Credentials

- Rotate every Dodo API key and webhook signing secret shared in chat. Do this before accepting public purchases; update Worker secrets and the matching Dodo endpoint together.
- Keep Dodo and R2 secrets only in Cloudflare Worker secrets. Never put them in the extension, phone website, screenshots, logs, ZIP, Git, or store review instructions.
- Terminal commands from `transfer-worker`: `npx wrangler secret put DODO_API_KEY` and `npx wrangler secret put DODO_WEBHOOK_SECRET`. Paste values into the prompts, not shell commands or chat. Leave R2 secrets unchanged unless rotating them intentionally.
- Keep billing recovery keys and phone/device tokens private. Save recovery keys before payment.
- Firebase web configuration is public client configuration, not a private backend key. If enabling that service, protect data with deployed authentication/security rules and appropriate API restrictions. Never ship a service-account key.
- Enable two-factor authentication on Cloudflare, Dodo, Netlify and the Chrome Web Store developer account.

## Payments and release testing

- The shared Worker now uses live mode. Only actual payment methods belong in live checkout; sandbox test cards will not work there.
- Verify a controlled, explicitly authorized live purchase, signed webhook delivery, persistent Pro status, cancellation/renewal behavior and recovery. No live purchase was made during preparation.
- Sandbox subscriptions do not grant live Pro. Preserve the sandbox recovery key and generate a new key for any live checkout.
- Establish refund/chargeback handling before launch: the code does not process those events separately. A refund alone may not revoke Pro; verify/cancel the subscription in Dodo as part of the support procedure.
- Check your end-user cancellation/refund terms, support email, monthly USD pricing plus taxes and paid-feature disclosures.
- Confirm Free = 5 successful image sends per rolling 24 hours, 20 clips/category and 1 phone. Pro = 50 images stored/phone, 100 clips/category and 2 phones. Phone content remains temporary for 24 hours on both plans.
- Confirm phone pairing, preview/share/download/delete, quota prompts, local image retention and keyboard shortcuts using a clean browser profile and an actual phone.
- Anonymous Free identities can be recreated. These limits are not an abuse-proof per-person quota. Enable usage monitoring/alerts and keep a service-disable procedure ready.

## Store disclosures

- Update screenshots, description, privacy URL and the dashboard's data-handling disclosures to cover clipboard content, optional phone/cloud transfers and Dodo billing.
- Explain broad HTTP/HTTPS access and sensitive permissions in the dashboard. Request only permissions the extension actually uses.
- Provide review instructions for Free pairing/transfer and Pro behavior without publishing API keys or a customer's private recovery key.
- Keep the R2 one-day object lifecycle rule enabled. Physical deletion is asynchronous; do not promise an exact deletion time.

Official guidance: https://developer.chrome.com/docs/webstore/publish and https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
