# CloudTunnel Manager

Self-hosted control plane for Cloudflare Tunnels: a **Cloudflare Worker + D1 + KV** API, a **Linux Go agent**, and a **React dashboard** (Cloudflare Pages).

## Repository layout

| Path | Role |
|------|------|
| `worker/` | HTTP API (`wrangler deploy`) |
| `dashboard/` | Operator UI (`vite build`, optional `wrangler pages deploy`) |
| `agent/` | Edge binary (`cloudtunnel-agent`) |
| `scripts/setup.sh` | First-time CF resources + `wrangler.toml` generation |
| `scripts/deploy.sh` | D1 migrations + Worker deploy + optional Pages deploy |
| `scripts/install.sh` | Linux systemd installer for the agent |

See [`brainstorm.md`](brainstorm.md) for architecture notes.

## Operator quick start

### Prereqs

- Node.js + npm (repo root and `worker/` / `dashboard/`)
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/install-and-update/) logged in
- `jq`, `openssl`

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

For a production Pages build, set `VITE_API_BASE_URL` at build time (see `dashboard/.env.example`).

### 4) Install the agent on Linux

From the deployed Worker (script is proxied from GitHub `main` by default):

```bash
curl -fsSL "https://YOUR-WORKER.workers.dev/install.sh" | sudo bash -s -- --worker-url "https://YOUR-WORKER.workers.dev"
```

Or from this repo:

```bash
curl -fsSL https://raw.githubusercontent.com/huukhanh/cftun-mager/main/scripts/install.sh | sudo bash -s -- --worker-url "https://YOUR-WORKER.workers.dev"
```

The installer will:

- Install **`cloudflared`** from Cloudflare releases (unless `CLOUDTUNNEL_SKIP_CLOUDFLARED=1`).
- Install **`cloudtunnel-agent`** via **`go install`** when Go is available, otherwise require **`CLOUDTUNNEL_AGENT_URL`** pointing at a prebuilt `linux/amd64` or `linux/arm64` binary.
- Create user **`cloudtunnel`**, write `/etc/cloudtunnel/agent.env`, enable **`cloudtunnel-agent.service`**.

## Development checks

```bash
cd worker && npm test && npx tsc --noEmit
cd ../dashboard && npm install && npm run build
cd ../agent && go test ./...
```
