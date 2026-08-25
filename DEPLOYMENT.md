# Deployment

## Decision (2026-08-21)

Host the app on **Oracle Cloud Always Free** with **DuckDNS** for the domain.

Reason: this is a learning app with no budget. Oracle Always Free costs $0 forever.
DuckDNS gives a free hostname. Caddy gives free HTTPS.

## Target host

- **Oracle Cloud — Always Free tier**, ARM (Ampere A1) instance.
- Up to 4 CPU and 24 GB RAM are free. Use about 4 GB RAM for this app.
- All images (Node, Postgres, OpenSearch) have arm64 builds, so ARM is fine.
- Fallback if free ARM capacity is unavailable in the region: Hetzner CX22 (~€4/month).

## Architecture

One instance runs the whole stack with Docker Compose:

| Service | Role |
| --- | --- |
| App (Node, React Router 7) | Web admin, app proxy, webhooks. Port 3000. |
| Postgres 16 | Sessions and app data (`DATABASE_URL`). |
| OpenSearch 2.12 (kNN) | Search index (`OPENSEARCH_URL`). Heap capped at 512 MB. |
| Caddy | Reverse proxy. Automatic HTTPS via Let's Encrypt. |

## Constraint: single instance only

The cron (drain + reconcile) is an in-process `setInterval`. It is single-instance
only. See memory `cron-in-process-single-instance`.

- Run exactly one app instance.
- Do not auto-scale and do not auto-stop the machine. The cron needs the process
  always on.
- To scale later, add a leader lock or move cron to an external scheduler first.

## Domain and HTTPS

1. Register a free hostname on DuckDNS (for example `norma-ai-search.duckdns.org`).
2. Point the DuckDNS record at the Oracle instance public IP.
3. Caddy requests a Let's Encrypt certificate for that hostname automatically.

## Environment variables (production)

- `DATABASE_URL`
- `OPENSEARCH_URL`
- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SCOPES`
- `SHOPIFY_APP_URL` (the DuckDNS HTTPS URL)

Never commit `SHOPIFY_API_SECRET`. Set it on the server only.

## Deploy steps

1. Create the Oracle Always Free ARM instance (about 4 GB RAM).
2. Open the firewall for ports 80 and 443.
3. Install Docker and Docker Compose.
4. Register the DuckDNS hostname. Point it at the instance IP.
5. Add a production `docker-compose.yml` (app + Postgres + OpenSearch + Caddy).
6. Add a `Caddyfile` for the DuckDNS hostname.
7. Set the production env vars.
8. Run `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build`.
   The app runs `prisma migrate deploy` on start.
9. Update `shopify.app.toml`:
    - `application_url` -> the DuckDNS HTTPS URL
    - `[app_proxy].url` -> `https://<host>/proxy/search`
    - `[auth].redirect_urls` -> `https://<host>/api/auth`
10. Run `shopify app deploy` to push config, webhooks, and the theme extension.

Note: do NOT run `npm run migrate-index` at first deploy. It rebuilds an
EXISTING per-store index; no index exists until a store installs the app and
its products ingest. Run it later only after an analyzer mapping change.

## Cost

$0 per month (Oracle Always Free + DuckDNS + Let's Encrypt).

## Open items

- Production `docker-compose.yml` and `Caddyfile` are not written yet.
- The current `docker-compose.yml` is dev-only (no app service, no HTTPS).
