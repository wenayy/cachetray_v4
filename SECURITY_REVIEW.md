# CacheTray 1.7.4 review

## What the frontend cannot grant itself

The API authenticates a random device credential on each protected request, derives its plan from server subscription records, and ignores client plan/limit fields. Editing `ct_phone_plan_v1` only changes a local display until the next refresh. Checkout always uses the server-configured product and quantity 1. Pro activation requires a signed Dodo webhook and a server request for the current subscription; the browser return page does not grant access. Recovery moves an existing subscription rather than copying it.

Free: 5 successful image sends per installation in any rolling 24 hours, 20 newest items per category, 1 active paired phone per Mac. Pro: 50 images stored per receiving phone, 100 items per category, 2 phones per Mac. Atomic SQL reservations prevent concurrent daily-quota or storage-quota bypass. A separate successful-send ledger survives image deletion and cleanup until its 24-hour quota window ends. Failed/aborted uploads do not consume successful-send allowance. Phone clip responses cap the combined inbox across senders. Existing received images are preserved after a downgrade; sends from the past 24 hours, including Pro sends, count toward the Free allowance.

Transfer and clip routes check ownership and pairing. Billing keys and device tokens are capabilities: keep them private. They are hashed in the database. SQL values use bound parameters. Text received from clients is rendered through textContent. Image MIME types are restricted; SVG uploads are excluded.

## Changes in this update

- Billing records and recovery keys are scoped to the configured Dodo mode and product. A sandbox subscription cannot grant live Pro. Historical unscoped subscriptions are treated as sandbox and cannot grant live access.
- Image-start attempts: at most 60 per Mac identity per 10 minutes. Clip writes: at most 120 per Mac identity per 10 minutes. These are rate controls, not daily image allowances.
- Small JSON request bodies are checked by actual byte size as well as the Content-Length header.
- Presigned PUT signatures bind the declared MIME type and exact Content-Length. The extension uploads the original Blob; the browser supplies its Content-Length automatically. Ready status additionally checks R2's actual object size and MIME type.
- Successful-send history is stored locally after ready verification and is not used as proof of paid entitlement. It is historical; temporary cloud copies may have expired or been deleted.

## Remaining limits of the current design

This is an anonymous device/installation model, not a user account system. A determined person can create new device identities or reinstall to obtain fresh Free service. IP-based registration throttling reduces casual abuse but does not stop VPN/IP rotation. Per-user billing and quotas require durable accounts or another verified identity before stronger promises can be made.

Presigned upload URLs can be reused for the same object until their five-minute expiry. Binding Content-Length prevents a larger upload, but does not make the URL single-use or bind the image's exact bytes. A person holding the URL can replace that object with another body of the same size/MIME type until expiry. Short-lived capability URLs must not be logged or shared; stronger immutable finalization/content hashes are follow-up work.

Refunds/chargebacks need an operational policy; subscription status updates are handled, separate refund events are not. Missing cancellation webhooks can leave the previously active entitlement until its stored renewal deadline plus one day. Dodo sandbox activation, metadata propagation, cancellation, and recovery must be exercised with the real test product before charging real customers.

Rate limits do not guarantee a spending ceiling. Configure Cloudflare budget/usage monitoring and a kill switch before a large rollout. R2 expiration requires the bucket's one-day lifecycle rule; hiding a transfer after 24 hours is not proof that the object has been physically deleted.

This is a focused code review and functional verification, not an independent penetration test.
