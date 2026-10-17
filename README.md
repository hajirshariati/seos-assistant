# SEoS Assistant

An embedded Shopify admin app that adds an AI shopping assistant to the
storefront. Customers chat in a widget on any page; the assistant answers
product questions using the merchant's catalog, knowledge files, and
optional integrations (Klaviyo, Yotpo, Aftership). Powered by Anthropic
Claude.

## Architecture

- **Admin** (`app/routes/app.*.jsx`) — embedded Polaris UI: Home (setup
  checklist + test chat), Knowledge, Catalog, Smart Recommenders, Analytics,
  Settings. Uses React Router and `@shopify/shopify-app-react-router`.
- **Chat engine** (`app/lib/lean/`) — Claude decides, code checks facts.
  Claude gets tools (catalog search, product details, similar products,
  show cards, store info, customer service, plus store add-ons: orders, fit,
  reviews, recommenders, newsletter); every answer is fact-checked against
  what the tools returned and rewritten once if it names a product, price or
  fact that wasn't returned.
- **Storefront chat widget** (`extensions/hajirai-chat-widget/`) — Online
  Store theme app extension (app embed, `target: body`). Vanilla JS, no
  framework. Talks to `/apps/hajirai/chat` via Shopify's app proxy.
- **Public endpoints**
  - `app/routes/chat.jsx` — rate limit, request size and daily cap, then the
    chat engine (streamed as server-sent events)
  - `app/routes/feedback.jsx` — thumbs up/down, IP hashed
  - `app/routes/widget-config.jsx` — runtime config for the widget
- **Data** — PostgreSQL via Prisma. See `prisma/schema.prisma`.
- **Privacy** — chat conversations are anonymized via SHA-256 hash of
  source IP. No customer-identifiable data is stored. Old feedback and
  product mentions are auto-deleted after 90 days by a boot-time
  scheduler (`app/lib/retention.server.js`). At-rest secrets (Anthropic
  key, Klaviyo private key, etc.) are encrypted with AES-256-GCM
  (`app/utils/encryption.server.js`).

## Setup

1. Install dependencies:
   ```sh
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in values. Generate a 32-byte
   encryption key with:
   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. Run migrations:
   ```sh
   npx prisma migrate deploy
   ```
4. Start the dev server (Shopify CLI proxies the embedded admin):
   ```sh
   npm run dev
   ```

## Build & deploy

```sh
npm run build       # vite build (client + SSR)
npm start           # serve the production build
```

`npm run setup` runs `prisma generate && prisma migrate deploy` and is
suitable for a deploy hook. Required environment variables — see
`.env.example`. The app fails fast at boot if `ENCRYPTION_KEY` is missing
or not 32 bytes; this is intentional so a misconfigured deploy is loud.

## Webhooks

Configured in `shopify.app.toml` (api_version `2026-04`). All handlers
live under `app/routes/webhooks.*.jsx` and use
`authenticate.webhook(request)` for HMAC verification.

| Topic                                | Behavior                                |
| ------------------------------------ | --------------------------------------- |
| `app/uninstalled`                    | Purges every shop-scoped table          |
| `app/scopes_update`                  | Updates the session scope               |
| `products/{create,update,delete}`    | Mirrors catalog into the local cache    |
| `orders/create`                      | Records chat-attributed orders          |
| `customers/data_request` (GDPR)      | Returns/logs the customer's conversions |
| `customers/redact` (GDPR)            | Removes the customer id from conversions|
| `shop/redact` (GDPR)                 | Purges every shop-scoped table          |

## Merchant settings (admin)

- AI engine API key (encrypted at rest) and model
- **Daily message cap** — optional safety net. When enabled, the chat
  endpoint stops accepting new conversations once the configured count
  is hit for the UTC day; resumes at midnight UTC. Off by default.
- Chat features (follow-ups, feedback)
- Support / tracking / returns / referral / search results page URLs
- Klaviyo, Yotpo, Aftership integration keys (encrypted at rest)
- VIP mode (uses `read_customers`/`read_orders` to greet logged-in
  customers and use order history for size recommendations)
- Hide-on URLs (paths where the widget should not appear)

## Scripts

| Command               | Use                                    |
| --------------------- | -------------------------------------- |
| `npm run dev`         | Shopify CLI dev (admin + extension)    |
| `npm run build`       | Vite build for production              |
| `npm start`           | Serve the production build             |
| `npm run setup`       | Prisma generate + deploy migrations    |
| `npm run typecheck`   | React Router typegen + `tsc --noEmit`  |
| `npm run eval`        | All offline evals (no API key needed)  |
| `npm run eval:chat-transcripts` | Live chat scenarios against a deployed store |
| `npx prisma studio`   | DB inspector                           |

## Repository layout

```
app/
  routes/              # admin pages + webhooks + public endpoints
  models/              # Prisma helpers, one per table
  lib/lean/            # chat engine (tools, search, fact check)
  lib/                 # store knowledge, recommenders, billing, integrations
  utils/encryption.server.js
  shopify.server.js    # Shopify app config; asserts ENCRYPTION_KEY at boot
extensions/
  hajirai-chat-widget/ # theme app extension (storefront widget)
prisma/
  schema.prisma
  migrations/
shopify.app.toml
```

## License

Proprietary.
