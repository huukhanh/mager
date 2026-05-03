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

### 1) Configure Cloudflare resources

```bash
npm install                 # root (bcrypt helper for setup)
cd worker && npm install && cd ..
npm run setup               # interactive; writes .cloudtunnel.env + worker/wrangler.toml
```

During setup you may optionally set:

- **`WORKER_PUBLIC_URL`** — full Worker URL used as `VITE_API_BASE_URL` when building the dashboard (example: `https://cloudtunnel-worker.<your-subdomain>.workers.dev`).
- **`PAGES_PROJECT_NAME`** — Cloudflare Pages project name; when both are set, `npm run deploy` also builds and uploads `dashboard/dist`.

### 2) Deploy Worker (and optionally Pages)

```bash
npm run deploy
```

### 3) Run the dashboard locally

Proxy API calls to `wrangler dev` on port **8787**:

```bash
npm run dashboard:dev
```

For a production Pages build, set `VITE_API_BASE_URL` at build time (see `dashboard/.env.example`). Alternatively rely on deploy-time substitution when `WORKER_PUBLIC_URL` is configured during setup.

### 4) Install the agent on Linux

The Worker exposes **`GET /install.sh`**, which returns the installer shell script (fetched from this repo’s `main` branch on GitHub by default). Override the upstream URL with the **`INSTALL_SCRIPT_SRC_URL`** Worker var if you host your own copy.

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
- Install **`cloudtunnel-agent`** via **`go install`** when Go is available, otherwise require **`CLOUDTUNNEL_AGENT_URL`** pointing at a prebuilt `linux/amd64` or `linux/arm64` binary.
- Create user **`cloudtunnel`**, write `/etc/cloudtunnel/agent.env`, enable **`cloudtunnel-agent.service`**.

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

## Development checks

```bash
cd worker && npm test && npx tsc --noEmit
cd ../dashboard && npm install && npm run build
cd ../agent && go test ./...
```
