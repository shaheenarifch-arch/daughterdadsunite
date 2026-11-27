// Daughter Dads Unite checkout API (Cloudflare Worker)
//   GET  /health          -> which settings are present (no secret values)
//   GET  /product?slug=   -> live variants from Printful (size, colour, price, image)
//   POST /checkout        -> creates a Stripe Checkout Session, returns { url }
//   POST /stripe-webhook  -> on paid checkout, creates the Printful order

const PF = "https://api.printful.com";
const COLOR_HEX = { black: "#111111", white: "#ffffff", navy: "#1f2a44", "dark heather": "#3d3d42",
  "athletic heather": "#b9b9bd", "heather grey": "#b9b9bd", "sport grey": "#a7a7ab", red: "#a8202d",
  maroon: "#5b1a26", pink: "#f2b8c6", "soft pink": "#f4c9d4", purple: "#5b2a86", "team purple": "#4b2a7b",
  ash: "#d9d9d6", charcoal: "#36454f", "true royal": "#2350a3", royal: "#2350a3", green: "#2e6b3a",
  "forest green": "#22412d", brown: "#5a3d2b", tan: "#c8ad8a", "natural": "#efe6d2", "khaki": "#bfae86" };

function products(env) { try { return JSON.parse(env.PRODUCTS || "{}"); } catch { return {}; } }

function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}
const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json", ...headers } });

async function printful(env, path, init) {
  const res = await fetch(PF + path, {
    ...init,
    headers: { Authorization: "Bearer " + env.PRINTFUL_TOKEN, "X-PF-Store-Id": String(env.PRINTFUL_STORE_ID || ""),
      "Content-Type": "application/json", ...(init && init.headers) },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// Returns { name, images, variants:[{id,size,color,color_code,price_cents,image}] } or null.
async function loadProduct(env, slug, ctx) {
  const cfg = products(env)[slug];
  if (!cfg || !cfg.sync_product_id || !env.PRINTFUL_TOKEN) return null;
  const cacheKey = new Request("https://cache.ddu/product/" + slug + "/" + cfg.sync_product_id);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached.json();
  const r = await printful(env, "/store/products/" + cfg.sync_product_id);
  if (!r.ok || !r.body.result) return null;
  const sp = r.body.result.sync_product, svs = r.body.result.sync_variants || [];
  const images = [];
  const variants = svs
    .filter((v) => !v.is_ignored && v.availability_status !== "discontinued" && v.availability_status !== "out_of_stock")
    .map((v) => {
      const preview = (v.files || []).find((f) => f.type === "preview");
      const image = (preview && preview.preview_url) || (v.product && v.product.image) || sp.thumbnail_url;
      if (image && !images.includes(image)) images.push(image);
      const color = v.color || "";
      return { id: v.id, size: v.size || "", color, color_code: COLOR_HEX[color.toLowerCase()] || "#cccccc",
        price_cents: Math.round(parseFloat(v.retail_price) * 100), image };
    })
    .filter((v) => v.price_cents > 0);
  const data = { name: cfg.name || sp.name, images, variants };
  ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(data), { headers: { "Cache-Control": "max-age=300" } })));
  return data;
}

async function stripe(env, path, params) {
  const res = await fetch("https://api.stripe.com/v1" + path, {
    method: params ? "POST" : "GET",
    headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  return { ok: res.ok, body: await res.json() };
}

async function checkout(req, env, ctx, h) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Checkout not configured" }, 503, h);
  const { slug, variant_id, quantity } = await req.json().catch(() => ({}));
  const product = await loadProduct(env, slug, ctx);
  const v = product && product.variants.find((x) => x.id === Number(variant_id));
  if (!v) return json({ error: "Unknown product" }, 400, h);
  const qty = Math.max(1, Math.min(10, parseInt(quantity, 10) || 1));
  const label = [product.name, v.color, v.size].filter(Boolean).join(" / ");
  const p = {
    mode: "payment",
    success_url: env.SITE_URL + "/thank-you.html?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: env.SITE_URL + "/shop.html",
    "line_items[0][quantity]": qty,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": v.price_cents,
    "line_items[0][price_data][product_data][name]": label,
    "shipping_address_collection[allowed_countries][0]": "US",
    "shipping_options[0][shipping_rate_data][type]": "fixed_amount",
    "shipping_options[0][shipping_rate_data][display_name]": "Standard shipping (printed in 2-5 business days)",
    "shipping_options[0][shipping_rate_data][fixed_amount][amount]": env.SHIPPING_CENTS || "599",
    "shipping_options[0][shipping_rate_data][fixed_amount][currency]": "usd",
    "metadata[slug]": slug, "metadata[sync_variant_id]": v.id, "metadata[quantity]": qty,
    "payment_intent_data[description]": "Daughter Dads Unite: " + label,
  };
  if (v.image) p["line_items[0][price_data][product_data][images][0]"] = v.image;
  const r = await stripe(env, "/checkout/sessions", p);
  if (!r.ok) { console.log("stripe error", JSON.stringify(r.body.error)); return json({ error: "Checkout failed" }, 502, h); }
  return json({ url: r.body.url }, 200, h);
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

async function webhook(req, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response("not configured", { status: 503 });
  const raw = await req.text();
  const parts = Object.fromEntries((req.headers.get("Stripe-Signature") || "").split(",").map((kv) => kv.split("=")));
  const sigs = (req.headers.get("Stripe-Signature") || "").split(",").filter((s) => s.startsWith("v1=")).map((s) => s.slice(3));
  const t = parseInt(parts.t, 10);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return new Response("bad timestamp", { status: 400 });
  const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, t + "." + raw);
  if (!sigs.some((s) => safeEqual(s, expected))) return new Response("bad signature", { status: 400 });

  const event = JSON.parse(raw);
  if (event.type !== "checkout.session.completed") return new Response("ignored", { status: 200 });
  const s = event.data.object;
  if (s.payment_status !== "paid") return new Response("not paid", { status: 200 });
  const ship = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || {};
  const a = ship.address || {};
  const order = {
    external_id: "ddu" + s.id.replace(/[^A-Za-z0-9]/g, "").slice(-29),
    recipient: { name: ship.name || (s.customer_details && s.customer_details.name) || "Customer",
      address1: a.line1, address2: a.line2 || "", city: a.city, state_code: a.state, country_code: a.country || "US",
      zip: a.postal_code, email: s.customer_details && s.customer_details.email },
    items: [{ sync_variant_id: Number(s.metadata.sync_variant_id), quantity: Number(s.metadata.quantity) || 1 }],
    retail_costs: { shipping: ((Number(env.SHIPPING_CENTS) || 599) / 100).toFixed(2) },
  };
  const confirm = String(env.PRINTFUL_CONFIRM) === "true" ? "true" : "false";
  const r = await printful(env, "/orders?confirm=" + confirm, { method: "POST", body: JSON.stringify(order) });
  const dup = r.status === 400 && JSON.stringify(r.body).toLowerCase().includes("external");
  if (!r.ok && !dup) { console.log("printful error", r.status, JSON.stringify(r.body)); return new Response("printful failed", { status: 500 }); }
  return new Response("ok", { status: 200 });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), h = cors(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    try {
      if (url.pathname === "/health") {
        const p = products(env);
        return json({ ok: true, printful_token: !!env.PRINTFUL_TOKEN, printful_store: !!env.PRINTFUL_STORE_ID,
          stripe_key: !!env.STRIPE_SECRET_KEY, stripe_webhook: !!env.STRIPE_WEBHOOK_SECRET,
          printful_confirm: String(env.PRINTFUL_CONFIRM) === "true",
          products: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, !!v.sync_product_id])) }, 200, h);
      }
      if (url.pathname === "/product" && req.method === "GET") {
        const data = await loadProduct(env, url.searchParams.get("slug"), ctx);
        return data && data.variants.length ? json(data, 200, h) : json({ error: "Not available" }, 404, h);
      }
      if (url.pathname === "/checkout" && req.method === "POST") return checkout(req, env, ctx, h);
      if (url.pathname === "/stripe-webhook" && req.method === "POST") return webhook(req, env);
      return json({ error: "Not found" }, 404, h);
    } catch (e) {
      console.log("error", e && e.stack);
      return json({ error: "Server error" }, 500, h);
    }
  },
};
