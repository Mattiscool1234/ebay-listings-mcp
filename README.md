# eBay seller MCP

Remote [Model Context Protocol](https://modelcontextprotocol.io) server for one eBay seller account. An assistant calls it over Streamable HTTP and the server calls eBay's official Sell APIs with a user access token that it refreshes for you.

It can list and edit inventory, create and publish fixed-price offers, withdraw or delete them, read business policies and inventory locations, suggest categories and item specifics, and read orders. It acts only on the account that completes the OAuth consent screen.

The MCP endpoint is `POST /mcp`. OAuth setup is `GET /auth/start` and `GET /auth/callback`.

## What you need to provide

You do not need keys before cloning the repo. You do need them before the tools can call eBay.

| Variable | Required | Purpose |
| --- | --- | --- |
| `EBAY_CLIENT_ID` | Yes, to call eBay | App ID (Client ID) from your keyset |
| `EBAY_CLIENT_SECRET` | Yes, to call eBay | Cert ID (Client Secret) from the same keyset |
| `EBAY_RU_NAME` | Yes, for `/auth/start` | RuName for that environment. This is not the accept URL |
| `EBAY_ENV` | Yes | `sandbox` (default) or `production` |
| `EBAY_REFRESH_TOKEN` | One of these two | Paste a refresh token you already minted |
| `TOKEN_ENCRYPTION_KEY` | One of these two | Required so `/auth/start` can store the refresh token. `openssl rand -base64 32` |
| `MCP_AUTH_TOKEN` | Strongly recommended | Bearer token your assistant sends to `/mcp`. `openssl rand -hex 32` |

Set either `EBAY_REFRESH_TOKEN` or complete `/auth/start`. A token file, or a refresh token just captured in this process, is used when it exists. When neither exists, including after a Render free-plan restart, `EBAY_REFRESH_TOKEN` is used.

Optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TOKEN_STORE_PATH` | `./data/ebay-tokens.enc` | Encrypted refresh-token file |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `8787` | HTTP port |
| `PUBLIC_BASE_URL` | unset | Public origin, such as `https://ebay-mcp.example.com`, used for Host checks |
| `ALLOWED_HOSTS` | unset | Extra hostnames, comma-separated |
| `ALLOWED_ORIGINS` | localhost | Extra browser origins allowed to call `/mcp`. Requests with no `Origin` are allowed |
| `EBAY_CONTENT_LANGUAGE` | from the marketplace | `Content-Language` on inventory writes, for example `en-US` |

Leave `EBAY_API_BASE_URL`, `EBAY_AUTH_BASE_URL`, and `EBAY_IDENTITY_BASE_URL` unset. They exist for tests.

Sandbox and production do not share keys, RuNames, or refresh tokens. A sandbox token sent to production is rejected. The default environment is sandbox.

## Create an eBay developer account and keyset

1. Open [developer.ebay.com/join](https://developer.ebay.com/join) and sign in. Use the eBay account that should own the application. The seller who later clicks consent can be the same account.
2. Open [Application keys](https://developer.ebay.com/my/keys).
3. Create a keyset. Sandbox keys are issued immediately. Production keys require eBay to approve production access for the application.
4. Copy the **App ID (Client ID)** into `EBAY_CLIENT_ID` and the **Cert ID (Client Secret)** into `EBAY_CLIENT_SECRET`. Sandbox and production each have their own pair. Match them to `EBAY_ENV`.
5. On the same keyset, open the OAuth scopes and include:
   - `https://api.ebay.com/oauth/api_scope/sell.inventory`
   - `https://api.ebay.com/oauth/api_scope/sell.account`
   - `https://api.ebay.com/oauth/api_scope/sell.fulfillment`
   - `https://api.ebay.com/oauth/api_scope/commerce.identity.readonly`
   Category suggestions also use an application token with `https://api.ebay.com/oauth/api_scope` (client-credentials). That scope is on a new keyset by default.
6. For sandbox end-to-end tests, create a sandbox test user at [developer.ebay.com/sandbox](https://developer.ebay.com/sandbox) and consent with that user. Sandbox listings are not visible on the real eBay site.

The Dev ID is not used.

## Create a RuName

eBay does not send the browser to a URL you pass at runtime. It sends the browser to the **Accept URL** saved on a Redirect URL name (RuName). The OAuth `redirect_uri` parameter is that RuName.

1. From the keyset, open **User Tokens** (or the notification / redirect URL settings linked from the keys page).
2. Add a Redirect URL if you do not have one.
3. Set the **Accept URL** to the callback on this server:
   - Local sandbox, browser on the same machine: `http://localhost:8787/auth/callback`
   - Any deployed or tunneled server: `https://YOUR_HOST/auth/callback`
4. Set the **Reject URL** to the same path. A declined consent is shown as a failure page and nothing is stored.
5. Production keysets expect an `https` accept URL. Use the sandbox RuName with sandbox keys and the production RuName with production keys.
6. Copy the **RuName** string itself into `EBAY_RU_NAME`. It looks like a name, not a URL.

The path must be exactly `/auth/callback`. eBay appends `code` and `state`.

## Run locally

```bash
cp .env.example .env
# fill in the variables above
npm install
npm run dev
```

The process listens on [http://127.0.0.1:8787](http://127.0.0.1:8787) unless you change `PORT`.

- `GET /health` reports whether credentials and a refresh token are configured. It does not return them.
- `GET /` is a short status page.
- `npm run build` then `npm start` runs the compiled server.

Connect the seller account:

1. Set `TOKEN_ENCRYPTION_KEY`.
2. If `MCP_AUTH_TOKEN` is set, open `/auth/start`, enter that token, and continue. The token is posted in the form and is not placed in the URL. `curl -H "Authorization: Bearer $MCP_AUTH_TOKEN" -i http://127.0.0.1:8787/auth/start` also works.
3. If `MCP_AUTH_TOKEN` is unset, `/auth/start` redirects straight to eBay. Set the token before anyone else can reach the port.
4. Sign in on eBay and agree. The browser returns to `/auth/callback`. The page says the account is connected and does not display the refresh token.
5. The token is written to `TOKEN_STORE_PATH` with AES-256-GCM. The file mode is `0600`.

`/auth/start` and `/auth/callback` must hit the same process. The OAuth `state` value is kept in memory for 10 minutes.

You can skip the browser flow by setting `EBAY_REFRESH_TOKEN` yourself. eBay's portal can mint one from the User Tokens page, or any standard authorization-code exchange can. Do not commit it.

## Before the first listing

Inventory API publishing requires three things that live on the seller account, not in this repo:

1. Opt in to business policies in Seller Hub (Account settings → Business policies).
2. Create a fulfillment (shipping) policy, a payment policy, and a return policy for the marketplace. `get_listing_policies` returns their ids. This server does not create policies.
3. Create an inventory location with `create_inventory_location`, or reuse one from `list_inventory_locations`. Offers need `merchantLocationKey`.

Images are URLs, not uploads. `create_or_replace_inventory_item` accepts public `https` URLs that eBay's servers can fetch. That includes images you host yourself and URLs already stored by eBay Picture Services or the eBay Media API. `http` URLs and URLs with embedded credentials are rejected.

A fixed-price listing is four calls: inventory item, then offer, then `publish_offer`. `suggest_category` and `get_item_aspects_for_category` choose the leaf category and the item specifics. eBay does not return reliable category names in sandbox.

## Sandbox and production

| | Sandbox | Production |
| --- | --- | --- |
| `EBAY_ENV` | `sandbox` | `production` |
| API host | `api.sandbox.ebay.com` | `api.ebay.com` |
| Consent host | `auth.sandbox.ebay.com` | `auth.ebay.com` |
| Seller | Sandbox test user | The real seller account |
| Listing URL | `https://www.sandbox.ebay.com/itm/{id}` | The marketplace site, such as `https://www.ebay.com/itm/{id}` |

Change `EBAY_ENV`, the keyset, the RuName, and the refresh token together. Delete the old token file or point `TOKEN_STORE_PATH` at a new file when you switch. A stored token is used ahead of `EBAY_REFRESH_TOKEN`. With no token file and no in-process OAuth result, the server uses `EBAY_REFRESH_TOKEN`.

## Deploy

The container listens on `8787`, runs the server as the unprivileged `app` user, and keeps the token file on `/data`.

```bash
docker build -t ebay-seller-mcp .
docker run --env-file .env -p 8787:8787 -v ebay-mcp-data:/data ebay-seller-mcp
```

Or:

```bash
docker compose up --build
```

`docker-compose.yml` expects a `.env` next to it and stores tokens in the `ebay-mcp-data` volume.

Set `PUBLIC_BASE_URL` to the origin buyers of the connector will use, and set the RuName accept URL to `$PUBLIC_BASE_URL/auth/callback`. Set `MCP_AUTH_TOKEN` before the service is reachable.

Any host that runs a container can serve it (a VM, Fly.io, Railway, Cloud Run, and similar). Give it the environment variables above and a persistent disk mounted at `/data`. Run a single replica while someone is completing `/auth/start`, because OAuth state is in memory. After the token file is on the volume, extra replicas can share that volume; prefer one replica so two refreshes cannot race.

Do not bake `EBAY_CLIENT_SECRET`, `EBAY_REFRESH_TOKEN`, `TOKEN_ENCRYPTION_KEY`, or `MCP_AUTH_TOKEN` into the image.

## Deploy on Render

`render.yaml` defines one free web service named `ebay-listings-mcp`. It builds the Dockerfile, listens on the `PORT` Render sets, and health-checks `GET /health` (that route returns 200 and includes no secrets).

Render cannot clone a Cursor Origin repo, so the code has to live on GitHub. In the Render dashboard, create a Blueprint from this repo. Render prompts for every `sync: false` variable. `EBAY_ENV` is already `production`. Leave the secret values out of git.

The free plan has no persistent disk. The process can hold a refresh token until it sleeps or redeploys, and then it is gone. After the first deploy:

1. Set `MCP_AUTH_TOKEN` before you sign in. The reveal step refuses to run without it.
2. On the production RuName, set the Accept URL and Reject URL to `https://YOUR-SERVICE.onrender.com/auth/callback`. The path is `/auth/callback`.
3. Open `https://YOUR-SERVICE.onrender.com/auth/start` and approve access on eBay.
4. On the success page, enter `MCP_AUTH_TOKEN`. The refresh token is shown once, in the page, and is not written to the log. A second request does not show it again.
5. Paste that value into Render's `EBAY_REFRESH_TOKEN` and redeploy. The next boot has no token file, so this environment variable is what the server uses.

The MCP URL is `https://YOUR-SERVICE.onrender.com/mcp`.

## Add it as an MCP connector

The connector URL is:

```text
https://YOUR_HOST/mcp
```

Use Streamable HTTP. Send this header on every request when `MCP_AUTH_TOKEN` is set:

```text
Authorization: Bearer YOUR_MCP_AUTH_TOKEN
```

Cursor: Settings → Tools & MCP → add a new MCP server, choose the HTTP / URL transport, paste the URL, and add the header.

A typical client config:

```json
{
  "mcpServers": {
    "ebay-seller": {
      "url": "https://YOUR_HOST/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

The server is stateless. Clients do not need a sticky session for tool calls. `tools/list` returns the tools below.

Ask the assistant to call `get_seller_identity` before it changes inventory, and to confirm with you before `publish_offer`, `withdraw_offer`, or `delete_inventory_item`.

## Tools

| Tool | What it does |
| --- | --- |
| `list_inventory_items` | Page through SKUs with title, condition, quantity, and image count |
| `get_inventory_item` | Full inventory record for one SKU |
| `create_or_replace_inventory_item` | Create or replace a SKU: title, description, condition, aspects, https image URLs, quantity |
| `create_offer` | Stage a fixed-price offer: SKU, marketplace, category, price, quantity, three policy ids, location key |
| `update_offer` | Merge changes into an offer. A published offer is revised on the live listing |
| `publish_offer` | **DESTRUCTIVE.** Turns the offer into a live listing and returns the listing id and URL |
| `withdraw_offer` | **DESTRUCTIVE.** Ends the live listing and keeps the offer so it can be published again |
| `delete_inventory_item` | **DESTRUCTIVE.** Deletes the SKU, its unpublished offers, and a single-variation live listing for that SKU |
| `bulk_update_price_quantity` | Update quantity and offer price/quantity. Published offers change on the live site. One eBay call per SKU |
| `list_offers` | Offers for one SKU, including ids, price, policies, and listing status |
| `get_listing_policies` | Fulfillment, payment, and return policies for a marketplace |
| `create_inventory_location` | Create a warehouse or store location |
| `list_inventory_locations` | List location keys |
| `suggest_category` | Taxonomy category suggestions for a product query |
| `get_item_aspects_for_category` | Required and optional item specifics for a leaf category |
| `list_orders` | Recent seller orders, with optional fulfillment and date filters |
| `get_order` | One order, including the fulfillment payload eBay returns |
| `get_seller_identity` | Username and account type of the connected seller |

`publish_offer`, `withdraw_offer`, and `delete_inventory_item` are also flagged with the MCP `destructiveHint` annotation.

## Security

- Access tokens stay in memory. Refresh tokens stay in `EBAY_REFRESH_TOKEN` or in the encrypted file. Logs, `/health`, the callback page, and tool results are passed through a redactor for bearer values, Basic credentials, eBay `v^1.1#` tokens, and the configured secrets.
- Set `MCP_AUTH_TOKEN` on any shared or public host. Without it, anyone who can open `/mcp` can operate the seller account.
- `/auth/start` asks for that same token before it sends the browser to eBay, so another person cannot overwrite your stored refresh token.
- Requests that include an `Origin` must match localhost, `PUBLIC_BASE_URL`, `ALLOWED_HOSTS`, or `ALLOWED_ORIGINS`. Non-browser MCP clients omit `Origin` and are allowed.
- When `PUBLIC_BASE_URL` or `ALLOWED_HOSTS` is set, the `Host` header must match that allow-list or localhost.
- This server does not log request URLs for the OAuth callback, so the authorization code is not written to the log.

## Development

```bash
npm test
npm run typecheck
npm run build
```

Tests mock eBay's token and Sell HTTP endpoints. They cover refresh reuse, a single in-flight refresh, redaction when refresh fails, the encrypted token file, schema rejection, `tools/list`, and a validated inventory write that checks the bearer token sent to eBay.

Node.js 22 or newer is required.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `No eBay user refresh token is configured` | Set `EBAY_REFRESH_TOKEN` or finish `/auth/start` |
| `Set TOKEN_ENCRYPTION_KEY` | Generate a key and restart, then run `/auth/start` again |
| `The token store could not be decrypted` | `TOKEN_ENCRYPTION_KEY` does not match the key that wrote the file |
| eBay `invalid_grant` | The refresh token expired, was revoked, or belongs to the other environment. Consent again |
| OAuth page says the RuName is wrong | `EBAY_RU_NAME` must be the RuName for this `EBAY_ENV`, and the accept URL must be this server's `/auth/callback` |
| Authorization expired | `/auth/start` and `/auth/callback` hit different replicas, or more than 10 minutes passed. Start again |
| Publish fails on policies or location | Opt in to business policies, then call `get_listing_policies` and `create_inventory_location` |
| Category or aspect errors | Use a leaf id from `suggest_category`. Sandbox category names are not reliable |
| Image rejected locally | Use `https` with no username or password in the URL |
| `401` from `/mcp` | Send `Authorization: Bearer` and the `MCP_AUTH_TOKEN` value |
| `403` from `/mcp` | The `Origin` or `Host` is not in the allow-list |
