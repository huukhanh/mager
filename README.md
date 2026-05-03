# CloudTunnel Manager

Self-hosted control plane for Cloudflare Tunnels: a **Cloudflare Worker + D1 + KV** API, a **Linux Go agent**, and a **React dashboard** (Cloudflare Pages). Operators deploy the Worker, open the dashboard to manage nodes and ingress, and install the agent on each Linux edge host.

## Repository layout

| Path | Role |
|------|------|
| `worker/` | HTTP API (`wrangler deploy`) |
| `dashboard/` | Operator UI (`vite build`, optional `wrangler pages deploy`) |
| `agent/` | Edge binary (`cloudtunnel-agent`) |
| `scripts/setup.sh` | First-time CF resources + `wrangler.toml` generation |
| `scripts/deploy.sh` | D1 migrations + Worker deploy + optional Pages deploy |
| `scripts/install.sh` | Linux systemd installer for the agent |

See [`brainstorm.md`](brainstorm.md) for architecture and storage details.

## Root npm scripts

| Script | What it runs |
|--------|----------------|
| `npm run setup` | Interactive setup (`scripts/setup.sh`) → `.cloudtunnel.env`, `worker/wrangler.toml` |
| `npm run deploy` | `scripts/deploy.sh` — migrations, Worker deploy, optional Pages when configured |
| `npm run dashboard:dev` | Vite dev server for the dashboard (API proxied to `wrangler dev` on port **8787**) |
| `npm run dashboard:build` | Production build of `dashboard/` only (does not deploy) |

## Operator quick start

### Prereqs

- Node.js + npm (repo root, `worker/`, and `dashboard/`)
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/install-and-update/) logged in to your Cloudflare account
- `jq`, `openssl` (used by setup)

### 1) Mint a Cloudflare API token (READ THIS — easy to get wrong)

Setup will prompt for a Cloudflare API token that the Worker stores as the `CLOUDFLARE_API_TOKEN` secret. The Worker uses this token for **three** flows: provisioning named tunnels, looking up the zone for each ingress hostname, and creating the proxied CNAME that routes the hostname to the tunnel. Skipping any of the three permissions causes ingress saves to silently leave DNS unprovisioned (the Save banner will say `permission_denied` or `zone_not_in_account`).

Create the token at <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → **Custom token**. The shape must be **exactly** these three rows:

| Category | Permission | Access |
|----------|------------|--------|
| **Account** | Cloudflare Tunnel | Edit |
| **Zone**    | Zone              | Read |
| **Zone**    | DNS               | Edit |

Resource scopes:

| Section | Setting |
|---------|---------|
| **Account Resources** | `Include → Specific account → <your account>` |
| **Zone Resources**    | `Include → All zones from an account → <same account>` |

> ⚠️ Zone Resources only appears once you add at least one **Zone-category** permission. Setting Zone Resources to a single specific zone (e.g. only `example.com`) means any *other* hostname you save in the dashboard will be reported as `zone_not_in_account`, even if its zone lives in the same Cloudflare account.

Common pitfalls to avoid:

- Picking **`Account → DNS Settings → Edit`** instead of **`Zone → DNS → Edit`**. `DNS Settings` controls account-level config (DNSSEC, default TTLs); it does **not** let the Worker create CNAMEs inside zones.
- Picking `Zone Resources → Specific zone → <one zone>` instead of `All zones from an account`. Future hostnames in other zones will fail.
- Picking the wrong account in Account Resources. The account ID stored in `.cloudtunnel.env` (`CLOUDFLARE_ACCOUNT_ID`) and the Account Resources scope must match.

**Verify the token in 1 second** before pasting it into Wrangler:

```bash
TOKEN='<paste-the-token>'
ACCT='<your account id>'

curl -sS https://api.cloudflare.com/client/v4/user/tokens/verify \
  -H "Authorization: Bearer $TOKEN" | jq '{success, status: .result.status}'
# → { "success": true, "status": "active" }

curl -sS "https://api.cloudflare.com/client/v4/zones?account.id=$ACCT&per_page=50" \
  -H "Authorization: Bearer $TOKEN" | jq '{success, count: (.result|length), names: [.result[]?.name]}'
# → names should list every zone you plan to put behind the tunnel
```

To rotate the token later (no redeploy needed; Workers pick up secret changes on the next request):

```bash
cd worker && npx wrangler secret put CLOUDFLARE_API_TOKEN
```

### 2) Configure Cloudflare resources

```bash
npm install                 # root (bcrypt helper for setup)
cd worker && npm install && cd ..
npm run setup               # interactive; writes .cloudtunnel.env + worker/wrangler.toml
```

During setup you may optionally set:

- **`WORKER_PUBLIC_URL`** — full Worker URL used as `VITE_API_BASE_URL` when building the dashboard (example: `https://cloudtunnel-worker.<your-subdomain>.workers.dev`). Must start with `http://` or `https://`; setting it to a bare name will produce same-origin requests against the Pages domain (404/405).
- **`PAGES_PROJECT_NAME`** — Cloudflare Pages project name; when both are set, `npm run deploy` also builds and uploads `dashboard/dist`.

### 3) Deploy Worker (and optionally Pages)

```bash
npm run deploy
```

### 4) Run the dashboard locally

Proxy API calls to `wrangler dev` on port **8787**:

```bash
npm run dashboard:dev
```

For a production Pages build, set `VITE_API_BASE_URL` at build time (see `dashboard/.env.example`). Alternatively rely on deploy-time substitution when `WORKER_PUBLIC_URL` is configured during setup.

### 5) Install the agent on Linux

The Worker exposes **`GET /install.sh`**, which returns the installer shell script (fetched from this repo's `main` branch on GitHub by default). Override the upstream URL with the **`INSTALL_SCRIPT_SRC_URL`** Worker var if you host your own copy.

From the deployed Worker:

```bash
curl -fsSL "https://YOUR-WORKER.workers.dev/install.sh" | sudo bash -s -- --worker-url "https://YOUR-WORKER.workers.dev"
```

Or fetch the script directly from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/huukhanh/cftun-mager/main/scripts/install.sh | sudo bash -s -- --worker-url "https://YOUR-WORKER.workers.dev"
```

The installer will:

- Install **`cloudflared`** from Cloudflare releases (unless `CLOUDTUNNEL_SKIP_CLOUDFLARED=1`).
- Install **`cloudtunnel-agent`**, trying these sources in order: explicit **`CLOUDTUNNEL_AGENT_URL`** → Worker proxy `${WORKER_URL}/agent/linux-<arch>` (302 → GitHub release) → direct GitHub release for this repo → `go install` if Go is present.
- Detect init system: with `systemd` it creates user **`cloudtunnel`**, writes `/etc/cloudtunnel/agent.env`, and enables **`cloudtunnel-agent.service`**. Without systemd (containers, WSL, minimal images) it installs a **`cloudtunnel-agentctl`** helper that supervises the agent via PID file + `nohup` + log redirection.

## HTTP API (Worker)

| Method | Path | Access |
|--------|------|--------|
| `GET` | `/install.sh` | Public — returns installer body (proxied upstream). |
| `POST` | `/api/register` | Public — agent bootstrap; provisions tunnel credentials in KV. |
| `POST` | `/api/auth/login` | Public — admin password → JWT (rate limited; see Security). |
| `GET` | `/api/nodes` | Admin JWT (`Authorization: Bearer …`). |
| `GET` | `/api/nodes/:id` | Admin JWT. |
| `PATCH` | `/api/nodes/:id` | Admin JWT. |
| `DELETE` | `/api/nodes/:id` | Admin JWT. |
| `PUT` | `/api/nodes/:id/ingress` | Admin JWT. |
| `GET` | `/api/nodes/:id/config` | Node session JWT (issued at registration). |

## Security

- **`POST /api/auth/login`** is throttled to **10 attempts per client IP per rolling minute** (KV-backed counter). When exceeded, the API returns **429** with body `{ "error": "rate_limited" }` and a **`Retry-After`** header (seconds).
- **`POST /api/register`** is intentionally unauthenticated so agents can join; restrict exposure of your Worker URL at the network edge if that surface area matters for your threat model.

## Troubleshooting

### After saving ingress, the dashboard banner says one of…

`PUT /api/nodes/:id/ingress` returns a `dns: [...]` array; the dashboard banner renders each row. Per-hostname statuses:

| Status | Meaning | Fix |
|--------|---------|-----|
| `created` / `updated` / `unchanged` | DNS CNAME is correct; traffic should route through the tunnel. | Verify with `dig +short <hostname>` (Cloudflare proxy IPs) and `curl -v https://<hostname>`. |
| `permission_denied` | Worker's `CLOUDFLARE_API_TOKEN` lacks `Zone:Read` (zone listing) or `DNS:Edit` (record write). | Re-mint the token per [§1](#1-mint-a-cloudflare-api-token--read-this--easy-to-get-wrong) and `cd worker && npx wrangler secret put CLOUDFLARE_API_TOKEN`. |
| `skipped` (`zone_not_in_account`) | The hostname's zone is **not visible** to the token in the account configured by `CLOUDFLARE_ACCOUNT_ID`. The API call succeeded but returned no matching zone. | Almost always: `Zone Resources` was set to `Specific zone → <other zone>`. Re-mint with `Include → All zones from an account → <same account as CLOUDFLARE_ACCOUNT_ID>`. If the zone genuinely lives in another account, add it to the right account first. |
| `error` | Other Cloudflare API failure (rate limit, transient, schema). | Inspect `error` field; retry the save. |

### `curl https://<hostname>` returns Cloudflare 1033/1034 errors

The DNS record exists but the tunnel isn't healthy. Check on the agent host:

```bash
sudo systemctl status cloudtunnel-agent       # systemd hosts
cloudtunnel-agentctl status && cloudtunnel-agentctl logs   # non-systemd hosts
sudo cat /tmp/cloudtunnel-ingress-*.yml        # last-applied ingress config
```

Confirm the listed `service:` URL actually serves traffic locally (e.g. `curl -v http://localhost:8088`).

### Dashboard hits return `405 Method Not Allowed` or `404`

`WORKER_PUBLIC_URL` is set to a bare name instead of a full URL, so the dashboard issues same-origin API calls against the Pages domain. Edit `.cloudtunnel.env` and set `WORKER_PUBLIC_URL=https://<worker>.<subdomain>.workers.dev`, then `npm run deploy`.

### CloudShell / ephemeral hosts re-register as new nodes each session

`scripts/install.sh` generates a fresh node UUID per install. On hosts where the filesystem persists between sessions, the existing `/etc/cloudtunnel/agent.env` is reused; on ephemeral hosts (e.g. AWS CloudShell), each session creates a new node. Delete stale nodes from the dashboard (`DELETE /api/nodes/:id` also revokes the underlying tunnel from Cloudflare).

## Development checks

```bash
cd worker && npm test && npx tsc --noEmit
cd ../dashboard && npm install && npm run build
cd ../agent && go test ./...
```
