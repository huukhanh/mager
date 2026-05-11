# Mager

A self-hosted control plane for **Cloudflare Tunnels**.

Run a tiny Cloudflare Worker + dashboard, install one agent per Linux box, and
expose any local port (`http://localhost:8088`, a Pi-hole, a home-lab API, your
work-from-home dev server) on a public hostname over Cloudflare's network — no
inbound port-forwarding, no static IP, no `ngrok` rental.

```
┌────────────┐  HTTPS   ┌──────────────────┐  outbound only   ┌────────────┐
│  Browser   │ ───────▶ │  app.example.com │ ◀──────tunnel─── │ your Linux │
└────────────┘          │ (Cloudflare edge)│                  │   box      │
                        └──────────────────┘                  └────────────┘
                                ▲
                                │ admin REST + dashboard
                                │
                        ┌───────────────┐
                        │ Mager Worker  │  ← you deploy this once
                        │  + D1 + KV    │
                        └───────────────┘
```

## Why this exists

Cloudflare's own Zero Trust dashboard is great, but:

- It does not give you an **API-driven**, multi-host inventory you can script against.
- Provisioning a new tunnel + DNS record + ingress rule for every machine is repetitive.
- There is no first-class way to install one agent per box and have it auto-bootstrap a named tunnel.

Mager is a thin layer on top of the Cloudflare API that handles the boring parts:

- One **Worker** stores nodes, ingress rules, and provisions `cfd_tunnel` + DNS
  records via the Cloudflare API.
- One **Linux agent** registers itself, fetches its config, and runs
  `cloudflared` with the right `TUNNEL_TOKEN` and ingress YAML.
- One **dashboard** lets you add/remove nodes, change ingress, and see status.

## When you should use it

Use Mager when you want to:

- Expose **multiple machines / containers / home-lab services** under one
  Cloudflare account, each on its own subdomain, without manually clicking
  through `dash.cloudflare.com`.
- Keep the control plane on **your** Cloudflare account (Worker + D1 + KV are
  all on the free tier for typical use).
- Provide a **shared admin UI** for a small team without giving everyone full
  Cloudflare dashboard access.

You probably **don't** need Mager if you only have one box — `cloudflared
tunnel create` and a single DNS record is simpler.

## What's in the box

| Path           | What it is |
|----------------|------------|
| `worker/`      | Cloudflare Worker — REST API, D1 schema, KV usage. Deployed by `wrangler`. |
| `dashboard/`   | React + Vite admin UI. Deployed to Cloudflare Pages. |
| `agent/`       | Go binary that runs on each Linux box and supervises `cloudflared`. |
| `scripts/`     | `setup.sh`, `deploy.sh`, `install.sh` — the three commands you'll run. |

---

## Setup (5 steps, ~5 minutes)

### Prerequisites

- A **Cloudflare account** with at least one zone (domain) you control.
- **Node.js 20+**, **`jq`**, **`openssl`**, and a working `wrangler login`.
- **Go 1.22+** *only* if you want to build the agent locally (most users skip this — the GitHub release ships prebuilt binaries).

> **Why these?** Wrangler is Cloudflare's official CLI for Workers/D1/KV. `jq` and `openssl` are used by `setup.sh` to parse Wrangler output and generate the session secret.

### 1. Clone and install

```bash
git clone https://github.com/huukhanh/mager.git
cd mager
npm install
(cd worker && npm install)
```

> **Why two installs?** The root `package.json` only carries the bcrypt helper used at setup time; the Worker is its own npm project so it can ship lean to Cloudflare.

### 2. Mint a Cloudflare API token

Open <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** →
**Custom token** and add **exactly these three rows**:

| Category    | Permission         | Access |
|-------------|--------------------|--------|
| **Account** | Cloudflare Tunnel  | Edit   |
| **Zone**    | Zone               | Read   |
| **Zone**    | DNS                | Edit   |

Resource scopes:

| Section              | Setting                                           |
|----------------------|---------------------------------------------------|
| Account Resources    | `Include → Specific account → <your account>`     |
| Zone Resources       | `Include → All zones from an account → <same>`    |

> **Why this exact shape?** `Cloudflare Tunnel: Edit` lets the Worker create
> tunnels. `Zone: Read` lets it look up which zone a hostname belongs to. `DNS: Edit`
> lets it write the proxied CNAME. Skip any one and "save ingress" silently
> stops creating DNS records (the dashboard will surface
> `permission_denied` / `zone_not_in_account`).
>
> **Why "all zones from an account"?** If you scope the token to a single zone,
> the Worker can only manage hostnames in that zone — the moment you add a
> hostname in any other zone owned by the same account, it fails with
> `zone_not_in_account`.

Verify the token before pasting it into setup:

```bash
TOKEN='<paste>'
curl -sS https://api.cloudflare.com/client/v4/user/tokens/verify \
  -H "Authorization: Bearer $TOKEN" | jq '{success, status: .result.status}'
# → { "success": true, "status": "active" }
```

### 3. Run setup

```bash
npm run setup
```

You'll be asked for **four** things:

1. **Instance name** — a short slug used as `<name>-mager`. Example: typing `home` gives you `home-mager` for D1, KV, Worker, and Pages project.
2. **Admin password** — what you'll use to log into the dashboard. Stored only as a bcrypt hash inside KV.
3. **Cloudflare account ID** — auto-detected from `wrangler whoami` if you're logged into a single account. Otherwise paste the 32-hex-char ID from the right sidebar of <https://dash.cloudflare.com>. Used to scope D1/KV/Worker creation and rendered into `wrangler.toml`.
4. **Cloudflare API token** — the one you minted in step 2. Leave empty to skip and set later with `cd worker && npx wrangler secret put CLOUDFLARE_API_TOKEN`.

> **Why a single instance name?** It avoids the typical "I named the worker
> `tunnel-mgr` but the KV `tun_kv` and now nothing matches" mistake. Everything
> on Cloudflare side is named uniformly so you can clean up later in one go.
>
> **What it does:** creates the D1 database, the KV namespace, renders
> `worker/wrangler.toml` from a template, hashes your password into KV, and
> stores the API token + a freshly generated session secret as Worker secrets.
> All inputs are persisted to `.mager.env` (gitignored) so re-runs are
> idempotent — press Enter to keep existing values.

### 4. Deploy

```bash
npm run deploy
```

This runs migrations, deploys the Worker, then builds and uploads the dashboard
to Pages. The Worker's public URL is auto-detected from the `wrangler deploy`
output and saved back to `.mager.env`, so the dashboard is built with the
correct `VITE_API_BASE_URL` on the same run.

> **Why Pages and not the Worker for the UI?** Pages is free, has zero cold
> start for static assets, and lets you add a custom domain in the Cloudflare
> dashboard without redeploying the Worker.

### 5. Install the agent on each box

The same one-liner works on Linux and macOS — `install.sh` detects the host
and picks the right binary, init system, and cloudflared install method.

```bash
curl -fsSL "https://<your-worker>.workers.dev/install.sh" \
  | sudo bash -s -- --worker-url "https://<your-worker>.workers.dev"
```

Supported targets: `linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64`.

> **Why curl-pipe-bash from your Worker?** The Worker's `/install.sh` is just a
> proxy to this repo's `scripts/install.sh` on GitHub — your operators don't
> need to know the GitHub URL, only the Worker URL. The Worker URL is also the
> only thing the agent needs at runtime.
>
> **What it does on Linux:** installs `cloudflared` and `mager-agent` to
> `/usr/local/bin`, creates a `mager` user, writes `/etc/mager/agent.env`, and
> starts a systemd unit (`mager-agent.service`). On hosts without systemd
> (containers, WSL, minimal images) it falls back to a PID-file daemon
> controlled by `mager-agentctl {start|stop|restart|status|logs}`.
>
> **What it does on macOS:** installs `mager-agent` to `/usr/local/bin`,
> installs `cloudflared` via Homebrew (or downloads the `.tgz` release if
> `brew` isn't present), strips the Gatekeeper quarantine xattr, writes
> `/etc/mager/agent.env`, and loads a `LaunchDaemon` at
> `/Library/LaunchDaemons/com.mager.agent.plist` running as root.

Open the dashboard, log in with the admin password from step 3, click the new
node, add an ingress rule like:

| Hostname            | Service               |
|---------------------|-----------------------|
| `home.example.com`  | `http://localhost:8088` |

Hit **Save**. About 2 seconds later, `https://home.example.com` is live.

#### Uninstalling the agent

Use the same installer with `--uninstall`. It stops the service, removes the
binary, state, logs, and (on Linux) the `mager` system user. Homebrew's
`cloudflared` is left alone.

```bash
curl -fsSL "https://<your-worker>.workers.dev/install.sh" \
  | sudo bash -s -- --uninstall
```

Then delete the now-offline node from the dashboard so it doesn't linger.

---

## HTTP API (Worker)

| Method  | Path                      | Auth                    |
|---------|---------------------------|-------------------------|
| `GET`   | `/install.sh`             | Public — agent installer |
| `GET`   | `/agent/<os>-<arch>`      | Public — 302 to GitHub release asset (`linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64`) |
| `POST`  | `/api/register`           | Public — agent bootstrap |
| `POST`  | `/api/auth/login`         | Public — admin password → JWT (10 attempts/IP/min, then 429) |
| `GET`   | `/api/nodes`              | Admin JWT |
| `GET`   | `/api/nodes/:id`          | Admin JWT |
| `PATCH` | `/api/nodes/:id`          | Admin JWT |
| `DELETE`| `/api/nodes/:id`          | Admin JWT |
| `PUT`   | `/api/nodes/:id/ingress`  | Admin JWT |
| `GET`   | `/api/nodes/:id/config`   | Node session JWT (issued at registration) |

`POST /api/register` is intentionally unauthenticated — it has to be, because a
fresh agent has no credentials. It only ever returns config for the node ID it
received, so an attacker who knows your Worker URL can register a useless
ghost node, but cannot read other nodes' tunnels. If that's still in your
threat model, put your Worker behind Cloudflare Access or restrict it at the
edge.

---

## Troubleshooting

### "After saving ingress, the dashboard banner says…"

`PUT /api/nodes/:id/ingress` returns a `dns: [...]` array; per-hostname status:

| Status | Meaning | Fix |
|--------|---------|-----|
| `created` / `updated` / `unchanged` | DNS CNAME is correct. | `dig +short <hostname>` should return Cloudflare proxy IPs. |
| `permission_denied` | Token lacks `Zone:Read` or `DNS:Edit`. | Re-mint per [step 2](#2-mint-a-cloudflare-api-token), then `cd worker && npx wrangler secret put CLOUDFLARE_API_TOKEN`. |
| `skipped` (`zone_not_in_account`) | The hostname's zone isn't visible to the token. Almost always means Zone Resources is set to a single zone. | Re-mint with `Include → All zones from an account`. |
| `error`             | Other Cloudflare API failure (rate limit, transient). | Check `error` field; retry. |

### `curl https://<hostname>` returns Cloudflare 1033/1034

DNS exists but the tunnel isn't healthy. On the agent host:

```bash
# Linux (systemd)
sudo systemctl status mager-agent
sudo journalctl -u mager-agent -f

# macOS (launchd)
sudo launchctl print system/com.mager.agent
sudo tail -f /var/log/mager/agent.log

# Containers / WSL / no init
mager-agentctl status && mager-agentctl logs

# Last-applied ingress config (any host)
sudo cat /tmp/mager-ingress-*.yml
```

Then confirm the `service:` URL is actually serving locally
(e.g. `curl -v http://localhost:8088`).

### macOS: agent never starts, `launchctl print` shows last exit status `78` or `126`

Gatekeeper quarantined the binary. `install.sh` strips the `com.apple.quarantine`
xattr automatically, but if you copied the binary in by hand:

```bash
sudo xattr -dr com.apple.quarantine /usr/local/bin/mager-agent /usr/local/bin/cloudflared
sudo launchctl kickstart -k system/com.mager.agent
```

### Dashboard hits return `405 Method Not Allowed` or `404`

`WORKER_PUBLIC_URL` is unset or not a full URL, so the dashboard issues
same-origin requests against the Pages domain. Re-run `npm run deploy` —
it will detect the URL from `wrangler deploy` output and write it to
`.mager.env`. If detection fails, set it manually:

```bash
echo 'WORKER_PUBLIC_URL=https://<your>-mager.<subdomain>.workers.dev' >> .mager.env
npm run deploy
```

### `npm run setup` says "failed to resolve KV namespace id"

Wrangler v4 sometimes lags after creating a KV namespace. Run setup again — the
script is idempotent. If it persists, list namespaces manually:

```bash
cd worker && npx wrangler kv namespace list
```

…and confirm `<name>-mager` is in the list.

### Ephemeral hosts (CloudShell, sandboxed VMs) keep registering as new nodes

`scripts/install.sh` generates a fresh node UUID per install and stores it in
`/etc/mager/node.id`. On hosts where the filesystem is wiped between sessions,
each session creates a new node. Use `DELETE /api/nodes/:id` from the
dashboard to clean up — it also revokes the underlying Cloudflare tunnel.

### "I want to start over"

```bash
# On Cloudflare side
cd worker
npx wrangler d1 delete    "$DB_NAME"     # or use the dashboard
npx wrangler kv namespace delete --namespace-id "$KV_ID"
# delete the Worker + Pages project from the Cloudflare UI

# Locally
rm -f .mager.env worker/wrangler.toml
npm run setup
```

---

## Development

```bash
cd worker     && npm test && npx tsc --noEmit
cd ../dashboard && npm install && npm run build
cd ../agent   && go test ./...
```

The agent's GitHub release is built by `.github/workflows/agent-build.yml` on
every `v*` tag and shipped as `mager-agent-linux-{amd64,arm64}` assets. The
Worker's `/agent/linux-<arch>` route 302-redirects to those assets so
`install.sh` can fetch them without you publishing your own binary mirror.

## License

MIT — see [`LICENSE`](LICENSE).
