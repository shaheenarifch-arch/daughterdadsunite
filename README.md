# Daughter Dads Unite

Website for [daughterdadsunite.org](https://daughterdadsunite.org): premium cause apparel, 50% of profits to RAINN.

## Under construction mode (since Nov 27, 2026)
Every page (home, shop, product pages, info pages and the 404 page) currently shows one
"Under construction" holding page. Nothing else was deleted: images, styles, fonts, scripts,
the checkout API in `worker/` and the Google verification file are unchanged.

To bring the full site back, either:
1. On GitHub, open the pull request "Put the site under construction" and press **Revert**, then merge the revert PR; or
2. Restore the pages from the `full-site-backup` branch, which holds the full site exactly as it was:
   `git checkout full-site-backup -- *.html README.md` then commit and push to `main`.

GitHub Pages republishes within a few minutes.

## How it fits together
- **Site** (repo root): static HTML/CSS on GitHub Pages, DNS on Cloudflare.
- **Checkout API** (`worker/`): a Cloudflare Worker at `api.daughterdadsunite.org`.
  Product pages load live sizes/colours/prices from Printful, customers pay on Stripe Checkout,
  and the Stripe webhook creates the order in Printful, which prints and ships it.
- If the API isn't configured or is down, product pages automatically show **Buy on Amazon** instead.

## Settings
See `worker/wrangler.toml` for the variables and the four secrets
(`PRINTFUL_TOKEN`, `PRINTFUL_STORE_ID`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`).
Check status any time at https://api.daughterdadsunite.org/health

## Adding a product
1. Create it in the Printful API store and note its sync product ID.
2. Add `"slug":{"sync_product_id":ID}` to `PRODUCTS` in `worker/wrangler.toml`.
3. Add a matching product page entry in the site (same slug).
