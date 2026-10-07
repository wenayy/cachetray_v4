# CacheTray Pro setup (version 1.7.5)

The Worker is configured for Dodo live mode with product `pdt_0Np9oDMbAPR3D75QQMagd` at USD $4.99/month plus applicable taxes, explicitly authorized by the operator on October 6, 2026. Its API key and webhook signing secret are stored as remote Worker secrets, not in the extension package. Live checkouts can charge real money. Sandbox activation was verified against Dodo and D1; no live purchase has been made by the assistant. Never put API keys or webhook secrets in extension or website JavaScript, or send them in chat. Rotate the live credentials shared in chat before public launch.

Migration `0006_billing_environment.sql` separates subscription grants and checkout recovery keys by mode and product. Historical records are marked as sandbox; they cannot grant live Pro. After the switch, keep the old sandbox key privately and use **New key** for a live checkout. Do not retry an unresolved checkout or pay a second time without checking its provider status.

## Plans

| Plan | Image allowance | Newest clips per category | Paired phones per Mac |
| --- | --- | --- | --- |
| Free | 5 successful sends per Mac in any rolling 24 hours | 20 | 1 |
| Pro, USD $4.99/month plus applicable taxes | 50 images stored per phone at once; no daily sending cap | 100 | 2 |

Categories are text, links, code and tasks. Phone content still expires after 24 hours on either plan. Free allows five successful image sends per installation in a rolling 24-hour window; sending the same image again also counts. Deleting or expiring inbox images does not reset this allowance. Each send renews its slot 24 hours after successful verification. Failed or cancelled uploads do not consume successful-send quota, but upload reservations hold allowance for up to 10 minutes to prevent concurrent bypass. Pro instead uses a 50-image per-phone storage limit; deletion or expiry frees a Pro slot. Migration `0005_daily_image_quota.sql` retains send history separately from phone images. These limits affect the phone service, not local extension storage. Clipboard payload size and request rate protections still apply.

Plans belong to a random Mac installation identity, not a login account. The user must save the private recovery key before checkout. A restored subscription moves Pro to the new installation rather than duplicating it. Device IDs are not a fraud-proof identity system; stronger account/abuse protection is a future improvement.

## Configure Dodo test mode first

1. Create a **recurring monthly USD $4.99 product** in Dodo's test environment. Do not use a one-time payment product. The price is configured in Dodo, not enforced by the display label in the extension.
2. In `transfer-worker/wrangler.jsonc`, set `DODO_MODE` to `test` and `DODO_PRODUCT_ID` to that test product ID. Pro limits are already 50 and 100.
3. Your terminal must be inside `transfer-worker`, where `wrangler.jsonc` defines the Worker name. From the project root, run `cd transfer-worker` first. Then enter secrets through the CLI prompts:

   ```sh
   npx wrangler secret put DODO_API_KEY

   ```

   If you see “Required Worker name missing”, you are probably still in the extension root. Alternatively, stay in the project root and use `npx wrangler secret put DODO_API_KEY --config transfer-worker/wrangler.jsonc` (repeat for `DODO_WEBHOOK_SECRET`). Paste the secret only when prompted, never after a pipe or into a shared file. Use newly rotated test credentials if earlier values were exposed.

4. Configure the Dodo webhook endpoint:
   `https://cachetray-transfer-api.cachetray-vinay.workers.dev/api/billing/webhook`
   Subscribe to all subscription events. Use the webhook signing secret as `DODO_WEBHOOK_SECRET`, not your API key.
5. Apply the billing migration and deploy:

   ```sh
   npx wrangler d1 migrations apply cachetray-transfers --remote
   npm run deploy
   ```

6. Publish the updated `cachetraywebsite` assets to Cloudflare Pages (`cachetray-web`). This includes `billing-return.html`, the updated Received page, and service worker. Keep the canonical `cachetray.gitflex.lol` domain; see `CLOUDFLARE_PAGES_SETUP.md`.
7. Reload the extension, open **Pro**, save its recovery key, and complete a Dodo sandbox checkout. The return page does not grant Pro: only a verified webhook plus a server-side subscription lookup does.

Official references: [Checkout sessions](https://docs.dodopayments.com/developer-resources/checkout-session), [Webhooks](https://docs.dodopayments.com/developer-resources/webhooks).

## Required checks before charging real users

- Verify that checkout metadata `cachetray_checkout_id` appears on the actual Dodo subscription. Without it the backend intentionally cannot grant Pro.
- Confirm a test purchase changes the original extension to Pro and permits 50 images, 100 clips/category, and a second phone.
- Repeat the checkout request and webhook: neither should create duplicate subscriptions or grants.
- Close checkout before the return redirect; webhook activation must still work.
- Cancel through **Manage subscription**, test renewal failure/on-hold and cancellation-at-period-end behavior in Dodo. A non-active provider state revokes Pro; scheduling cancellation should leave it active until Dodo changes that state.
- Restore using the saved key on another installation; the original installation must lose Pro.
- Refund/chargeback handling is not implemented separately: if Dodo does not cancel the subscription, revoke/cancel it in Dodo. Do not launch without an operational refund/chargeback policy.
- Confirm the bucket has the separate one-day object-expiration rule described in `SEND_TO_PHONE_SETUP.md`. The multipart-abort rule alone does not delete transferred images.

Outbound checkout safety is intentionally conservative: only one unresolved checkout per Mac, and repeated requests reuse its URL for up to 24 hours. An ambiguous provider timeout or expired checkout stays locked rather than risk a second charge. Before resetting a stuck checkout, support must inspect the session in Dodo, reconcile any subscription/webhook, and confirm it cannot still be paid. Then clear only that checkout's lock and let the user save a new recovery key. Automated expired-session reconciliation is a follow-up before a large public rollout.

## Go live only after the checks above

Create the matching live monthly product and live webhook. Switch `DODO_MODE` to `live`, set the live product ID, replace both secrets with the live values, and redeploy. Never share test and live keys/products. Keep the existing R2 secrets unchanged.

Local automated verification (Node 22):

```sh
node --test transfer-worker/test/*.test.js tests/*.test.js
```

These tests use real SQLite schema/queries and a mocked Dodo API. They do not prove a real payment succeeded. The billing migration must be applied before deploying the new Worker. Checkout remains unavailable without all three Dodo settings.
