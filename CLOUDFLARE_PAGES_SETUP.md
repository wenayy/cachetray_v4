# CacheTray website on Cloudflare Pages

Deployed October 6, 2026. Project: `cachetray-web`, account `257d1382cd7a62b32959c41c3257bf19`, production branch `main`.

- Production Pages URL: https://cachetray-web.pages.dev
- Verified deployment: https://d02367a4.cachetray-web.pages.dev
- Canonical domain: `cachetray.gitflex.lol`. Cloudflare reports Active for the domain, validation and verification. Public DNS resolves to Cloudflare; HTTPS homepage, phone inbox and billing return returned HTTP 200 when checked against the published IP with normal certificate validation.

Verified homepage, blog/article, privacy policy, Received page, billing return, scripts/styles, service worker, web manifest and both PWA icons. Unknown routes return HTTP 404. Phone/service-worker assets use revalidation headers and billing return uses no-store. Deployment contains only website assets and public transfer configuration; no Dodo/R2 private credentials or Vercel configuration.

## Finish the DNS step

The existing Wrangler OAuth login can deploy Pages but cannot read/edit DNS (Cloudflare returned HTTP 403). In Cloudflare → gitflex.lol → DNS → Records:

- Type: CNAME
- Name: cachetray
- Target: cachetray-web.pages.dev
- Proxy status: Proxied
- TTL: Auto

Search for an existing `cachetray` record first. Edit that record rather than creating a duplicate. Save its previous target for rollback. Do not edit the root domain, www, email records or other subdomains. The Pages custom-domain association has already been created; the CNAME must match it.

The DNS step was completed by the operator and the domain is now Active. The initial 522 during activation no longer appeared in the HTTPS checks. Some local DNS resolvers may still cache the prior record temporarily. Verify the installed phone PWA before retiring the old Netlify site. No backend, Dodo secret, R2 bucket, pairing URL or CORS changes are necessary because the canonical origin is unchanged.

## Future uploads

Run `node scripts/prepare-pages.cjs` from the extension project root. It outputs a temporary directory of website-only files after credential scanning. Deploy that exact directory with Wrangler:

```sh
npx wrangler pages deploy <prepared-directory> --project-name cachetray-web --branch main --commit-dirty=true
```

Use the installed Node 22/Wrangler in `transfer-worker` if the default Node version is too old. Do not deploy the extension repository root or put private credentials in website files. `_headers` is used by Pages. Vercel configuration is retained locally for reference but excluded by the preparation script.

Official custom-domain instructions: https://developers.cloudflare.com/pages/configuration/custom-domains/
