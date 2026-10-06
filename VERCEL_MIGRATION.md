# Move the CacheTray website to Vercel

Status: configuration prepared; no deployment or DNS cutover yet.

## Hosting scope

Deploy only `cachetraywebsite`, not the repository root or the extension ZIP. It is a static site: framework Other, no build command, output directory `.`. The folder contains Vercel routing/cache configuration, landing page, blog, privacy policy, phone PWA and billing return page. Vercel does not use Netlify's `_headers`; equivalent settings are in `vercel.json`. HTML-extension URLs and extensionless Received/Privacy/Billing/Blog links are preserved.

No private environment variables are needed in Vercel for this static site. Dodo and R2 secrets stay in Cloudflare Worker secrets. Workers, D1 and R2 do not move.

Vercel's Hobby plan is restricted to non-commercial, personal use. CacheTray now sells a subscription, so use a commercial Vercel plan. Do not enable a paid plan without the owner's approval.

## Deploy and check before DNS

1. Select the intended Vercel Pro team. From `cachetraywebsite`, run `vercel --scope <team-slug>` to deploy a preview, then `vercel --prod --scope <team-slug>` after verification. If Git-connected, set the project Root Directory to `cachetraywebsite` instead.
2. Check `/`, `/blog`, blog articles, `/privacy.html`, `/received`, `/received.html`, `/billing-return.html`, `/sw.js`, `/manifest.webmanifest`, scripts and icons.
3. Check script/manifest MIME types, service-worker cache headers, phone installation and QR UI. Production must be public, not behind Vercel authentication.
4. Preview origins are not authorized by the production Cloudflare CORS configuration. Do not change production origins just to make preview transfers work; perform full pairing/share/download checks after the canonical domain cutover.

## Keep the existing domain

1. Add `cachetray.gitflex.lol` under Vercel project Settings → Domains.
2. Copy the exact DNS target Vercel displays for this project. Replace only the DNS record for the `cachetray` subdomain at its current DNS provider. Leave email, root-domain records and other subdomains alone. Do not guess a generic Vercel target.
3. Wait for Vercel domain verification and HTTPS issuance, then confirm requests to `https://cachetray.gitflex.lol` reach Vercel.
4. Keep this same domain: the extension QR links, billing return URL, CORS/R2 origins and installed phone storage remain on the same origin. A different domain would require backend configuration changes and phone re-pairing because browser storage is origin-specific.
5. Verify an existing paired phone still receives clips/images and billing returns load. Don't buy another subscription just to test page loading.
6. Keep Netlify available until everything passes. Only then remove its custom-domain association or stop its deployments. Save the previous DNS target for rollback.

References: https://vercel.com/docs/project-configuration/vercel-json, https://vercel.com/docs/domains/working-with-domains/add-a-domain, https://vercel.com/docs/plans/hobby
