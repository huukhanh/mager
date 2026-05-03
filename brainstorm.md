# CloudTunnel Manager
**Technical Brainstorm & Architecture Notes**
_Tech Lead Working Document · v0.3 · Internal Draft_

---

> **Purpose of this document**
> Capture architecture decisions, open questions, and design trade-offs for a self-hosted Cloudflare Tunnel management layer. This is a living brainstorm — not a final spec. v0.3 adds repo structure, AI agent conventions, and the setup/deploy script design.

---

## 1. Problem Statement

Managing Cloudflare Tunnels across multiple Linux edge nodes is currently a manual, error-prone process. There is no central UI to register nodes, assign ingress rules, or monitor liveness. The goal is to build a lightweight management layer on top of `cloudflared` with near-zero infrastructure overhead, running entirely within Cloudflare's free tier.

- Operators must SSH into each machine to update tunnel ingress configs
- No visibility into which nodes are online and running their tunnels
- Rotating credentials or revoking a node requires manual CF API calls
- No audit trail of config changes per node

---

## 2. System Overview

The system has two main components: a control plane hosted entirely on Cloudflare's edge, and a lightweight Go agent that runs on each Linux node.

### 2.1 Control Plane (Cloudflare)

- Dashboard UI hosted on Cloudflare Pages (static SPA)
- Worker handles all API calls — node registration, ingress config, heartbeats, auth
- **D1 (SQLite)** is the primary operational store — node registry, liveness, config ack, audit log
- **KV** holds secrets and config blobs only — tunnel tokens, ingress rules, admin password hash
- Cloudflare API key lives only in Worker environment variables — never exposed

### 2.2 Go Client (Edge Node)

- Single static binary, no runtime dependencies
- Runs as a systemd service on Linux (`linux/amd64`, `linux/arm64`)
- Registers itself on first boot, gets a scoped session token
- Polls the Worker every ~30s to pull its ingress config
- Spawns and manages `cloudflared` as a subprocess
- Sends heartbeats so the Dashboard can show node liveness
- Never holds the Cloudflare API key — only a per-node tunnel token (passed via env var, never written to disk)

---

## 3. Storage Architecture

### 3.1 Why D1 + KV Together

The free tier constraints drove this split:

| | KV | D1 |
|---|---|---|
| Writes/day (free) | 1,000 | 100,000 |
| Reads/day (free) | 100,000 | 5,000,000 |
| Data model | Key-value blobs | SQLite — relational |
| Consistency | Eventually consistent (~60s) | Strongly consistent (single primary) |
| Best for | Secrets, config blobs | Structured state, liveness, audit |

With 30 nodes heartbeating every 30s:
```
100,000 writes/day ÷ 30 nodes ÷ 86,400s ≈ one write every 28s per node
```
D1's free write limit maps almost perfectly to a 30s poll interval — no compromise needed.

### 3.2 Storage Split

**KV** — secrets and config blobs (rare writes, fast edge reads)

| Key | Value |
|---|---|
| `node:{id}:tunnel` | `{ tunnelId, tunnelToken, createdAt }` |
| `node:{id}:ingress` | `[ { hostname, service } ]` |
| `auth:password` | bcrypt hash of admin password |

**D1** — structured operational state (frequent writes, queryable)

| Table | Purpose |
|---|---|
| `nodes` | Registry, liveness, config ack |
| `ingress_rules` | Normalized ingress per node |
| `audit_log` | Change history |

### 3.3 D1 Schema

```sql
CREATE TABLE nodes (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  registered_at     INTEGER NOT NULL,
  last_seen         INTEGER,
  last_config_hash  TEXT,
  last_applied_at   INTEGER,
  status            TEXT DEFAULT 'unknown'
);

CREATE TABLE ingress_rules (
  node_id     TEXT NOT NULL,
  hostname    TEXT NOT NULL,
  service     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (node_id, hostname),
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id     TEXT,
  action      TEXT NOT NULL,
  detail      TEXT,
  actor       TEXT,
  created_at  INTEGER NOT NULL
);
```

Liveness query example:
```sql
SELECT * FROM nodes
WHERE last_seen > unixepoch() - 90
ORDER BY name;
```

> **D1 write latency note**
> D1 has a single primary write region. Heartbeat writes from a Tokyo node route to the primary (e.g. US-East), adding ~150ms per write. At a 30s poll interval this is completely acceptable — it is not a hot path.

---

## 4. Architecture & Data Flow

### 4.1 Trust Hierarchy

| Layer | Credential | Stored In | Can Do |
|---|---|---|---|
| Cloudflare control | CF API Key | Worker env var only | Create/delete tunnels, manage CF resources |
| Node auth | Session token (JWT) | D1 + client memory | Read own ingress config, send heartbeats |
| Tunnel transport | Tunnel token (per-node) | KV + subprocess env var | Run that one specific tunnel only |

> **Key security property**
> The Go client never touches the Cloudflare API directly. It talks only to the Worker. A compromised node cannot affect other nodes or the CF account. The tunnel token is passed to `cloudflared` via `TUNNEL_TOKEN` env var — never written to disk, never appears in `/proc/pid/cmdline`.

### 4.2 Node Registration Flow

1. Client generates a UUID — stored locally at `/etc/cloudtunnel/node.id`
2. `POST /api/register` with `{ nodeId, machineName }` — session token returned in response body directly (avoids D1 read-after-write race)
3. Worker calls CF API to provision a Named Tunnel for this node
4. Worker stores `{ tunnelId, tunnelToken }` in KV, inserts node row into D1
5. Client fetches tunnel token via `GET /api/nodes/{id}/config`
6. Client passes tunnel token to `cloudflared` subprocess via `TUNNEL_TOKEN` env var
7. Client enters poll loop

### 4.3 Poll Loop

- Every 30s: `GET /api/nodes/{id}/config` — combined heartbeat + config in one request
- Worker updates `last_seen` in D1 on every poll (within free write budget)
- Client compares received ingress config hash to last-applied hash
- If changed: write temp `config.yml`, `SIGTERM` cloudflared, restart subprocess
- If Worker unreachable for >5 min: log error, keep running last known config
- If `cloudflared` exits unexpectedly: restart with exponential backoff (1s → 2s → 4s, cap 60s)

---

## 5. Dashboard Design

### 5.1 Auth

Single admin password for v1. Worker compares bcrypt hash stored in KV. On success returns a signed JWT (signed with Worker env var secret) with 8h TTL. No user accounts, no roles.

Rate limit `/api/auth/login`: 10 attempts per IP per minute via Workers Rate Limiting API.

### 5.2 Node List View

- Table: node name (editable inline), status badge (online / offline / unknown), last seen, tunnel hostname
- Status derived from D1 `last_seen`: online if `< 90s` ago, offline if older, unknown if null
- Click node → ingress editor
- Delete node: Worker calls CF API to revoke tunnel, deletes KV keys + D1 row — token instantly dead, audit log entry written

### 5.3 Ingress Editor

- List of `hostname → local service` mappings (e.g. `app.example.com → http://localhost:3000`)
- Save writes to KV + D1 `ingress_rules` — client picks up on next poll (~30s)
- Validation: hostname must be valid domain, service must be valid URL or `ssh://host:port`
- All changes written to `audit_log`

---

## 6. Go Client Design

### 6.1 Startup Sequence

1. Read `node.id` from `/etc/cloudtunnel/node.id` — generate and save if missing
2. `POST /api/register` (idempotent — safe to call on every boot)
3. Fetch ingress config and tunnel token
4. Spawn `cloudflared` with `TUNNEL_TOKEN` env var
5. Enter poll loop

### 6.2 Tunnel Token — No Disk Write

```go
cmd := exec.Command("cloudflared", "tunnel", "run")
cmd.Env = append(os.Environ(), "TUNNEL_TOKEN=" + token)
```

Token lives in Worker KV and Go process memory only. Never touches disk. Never appears in process args.

### 6.3 cloudflared Packaging

Ship `cloudflared` embedded in the binary at a pinned known-good version. Add `--system-cloudflared` flag for advanced users who want to manage their own version.

### 6.4 Systemd Unit

```ini
[Unit]
Description=CloudTunnel Manager Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cloudtunnel
ExecStart=/usr/local/bin/cloudtunnel-agent
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
```

### 6.5 Install Script

```sh
curl -fsSL https://your-worker.workers.dev/install.sh | sudo bash
```

Script: downloads binary for detected arch, creates `cloudtunnel` system user, writes systemd unit, enables and starts service.

---

## 7. Worker API Surface

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/register` | None | Register node, returns session token |
| `GET` | `/api/nodes/:id/config` | Session token | Heartbeat + ingress config + tunnel token |
| `GET` | `/api/nodes` | Admin JWT | List all nodes |
| `PATCH` | `/api/nodes/:id` | Admin JWT | Rename node |
| `PUT` | `/api/nodes/:id/ingress` | Admin JWT | Set ingress config |
| `DELETE` | `/api/nodes/:id` | Admin JWT | Delete node + revoke CF tunnel |
| `POST` | `/api/auth/login` | None | Password check, returns admin JWT |

---

## 8. Repository Structure

### 8.1 Layout

```
cloudtunnel/
├── README.md
├── AGENTS.md                        ← AI agent conventions (read first)
│
├── worker/                          ← Cloudflare Worker (TypeScript/Hono)
│   ├── src/
│   │   ├── index.ts                 ← entry point, route registration only
│   │   ├── middleware/
│   │   │   ├── auth-admin.ts        ← admin JWT validation
│   │   │   └── auth-node.ts         ← session token validation
│   │   ├── routes/
│   │   │   ├── register.ts          ← POST /api/register
│   │   │   ├── config.ts            ← GET /api/nodes/:id/config
│   │   │   ├── nodes.ts             ← GET|PATCH|DELETE /api/nodes
│   │   │   ├── ingress.ts           ← PUT /api/nodes/:id/ingress
│   │   │   └── auth.ts              ← POST /api/auth/login
│   │   ├── db/
│   │   │   ├── nodes.ts             ← all D1 queries for nodes table
│   │   │   ├── ingress.ts           ← all D1 queries for ingress_rules
│   │   │   └── audit.ts             ← all D1 queries for audit_log
│   │   ├── kv/
│   │   │   ├── tunnel.ts            ← KV get/set for tunnel tokens
│   │   │   └── ingress.ts           ← KV get/set for ingress blobs
│   │   ├── cf/
│   │   │   └── tunnel.ts            ← CF API calls (create/delete tunnel)
│   │   └── types.ts                 ← shared types/interfaces
│   ├── migrations/
│   │   ├── 0001_init.sql
│   │   └── 0002_audit_log.sql
│   ├── test/
│   │   └── routes/                  ← mirrors src/routes/ exactly
│   └── wrangler.toml                ← gitignored, generated by setup.sh
│
├── agent/                           ← Go client binary
│   ├── cmd/
│   │   └── cloudtunnel-agent/
│   │       └── main.go              ← flags, config load, wires everything
│   ├── internal/
│   │   ├── config/
│   │   │   └── config.go            ← load/save /etc/cloudtunnel/config.json
│   │   ├── registration/
│   │   │   └── register.go          ← POST /api/register logic
│   │   ├── poll/
│   │   │   └── poll.go              ← poll loop, diff, hash compare
│   │   ├── tunnel/
│   │   │   └── runner.go            ← spawn cloudflared subprocess
│   │   └── api/
│   │       └── client.go            ← typed HTTP client for Worker API
│   ├── embed/
│   │   └── cloudflared              ← pinned binary (gitignored, fetched by make)
│   └── Makefile
│
├── dashboard/                       ← Cloudflare Pages SPA
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   ├── NodeList.tsx
│   │   │   └── NodeDetail.tsx       ← ingress editor
│   │   ├── components/
│   │   │   ├── NodeRow.tsx
│   │   │   ├── StatusBadge.tsx
│   │   │   └── IngressEditor.tsx
│   │   ├── api/
│   │   │   └── client.ts            ← typed fetch wrapper, mirrors worker routes
│   │   └── types.ts                 ← own copy of types (not shared with worker)
│   └── package.json
│
├── schema/
│   └── api.ts                       ← canonical request/response types
│
└── scripts/
    ├── setup.sh                     ← interactive first-time setup (see §8.3)
    ├── deploy.sh                    ← runs migrations + wrangler deploy
    ├── teardown.sh                  ← deletes all CF resources (dev/reset)
    └── install.sh                   ← end-user curl installer for Go agent
```

### 8.2 Gitignored Files

```
wrangler.toml          ← generated from wrangler.toml.template by setup.sh
.cloudtunnel.env       ← persisted setup answers (DB name, KV name, worker name)
agent/embed/cloudflared
```

`wrangler.toml.template` is committed. `wrangler.toml` is generated — never edit it directly.

### 8.3 Setup & Deploy Scripts

**First-time setup flow:**

```
npm run setup   → scripts/setup.sh
npm run deploy  → scripts/deploy.sh
```

**Subsequent deploys:**

```
npm run deploy  → scripts/deploy.sh  (setup skipped, migrations + deploy)
```

#### `scripts/setup.sh`

Prompts interactively for all config. Re-running loads existing values as defaults — user just hits Enter to keep them.

```bash
#!/usr/bin/env bash
set -e

CONFIG_FILE=".cloudtunnel.env"

# Load existing config if present (re-run case)
if [ -f "$CONFIG_FILE" ]; then
  source "$CONFIG_FILE"
  echo "Found existing config at $CONFIG_FILE — press Enter to keep current values."
fi

# Prompt with existing values as defaults
read -p "D1 database name [${DB_NAME:-cloudtunnel-db}]: " input
DB_NAME=${input:-${DB_NAME:-cloudtunnel-db}}

read -p "KV namespace name [${KV_NAME:-cloudtunnel-kv}]: " input
KV_NAME=${input:-${KV_NAME:-cloudtunnel-kv}}

read -p "Worker name [${WORKER_NAME:-cloudtunnel-worker}]: " input
WORKER_NAME=${input:-${WORKER_NAME:-cloudtunnel-worker}}

read -s -p "Admin password: " PASS
echo

# Create D1 (idempotent)
echo "Creating D1 database '$DB_NAME'..."
DB_ID=$(wrangler d1 create "$DB_NAME" --json 2>/dev/null \
  | jq -r '.uuid') \
  || DB_ID=$(wrangler d1 info "$DB_NAME" --json | jq -r '.uuid')

# Create KV (idempotent)
echo "Creating KV namespace '$KV_NAME'..."
KV_ID=$(wrangler kv namespace create "$KV_NAME" --json 2>/dev/null \
  | jq -r '.id') \
  || KV_ID=$(wrangler kv namespace list --json \
  | jq -r ".[] | select(.title==\"$KV_NAME\") | .id")

# Generate wrangler.toml from template
sed \
  -e "s/{{DB_NAME}}/$DB_NAME/" \
  -e "s/{{DB_ID}}/$DB_ID/" \
  -e "s/{{KV_NAME}}/$KV_NAME/" \
  -e "s/{{KV_ID}}/$KV_ID/" \
  -e "s/{{WORKER_NAME}}/$WORKER_NAME/" \
  worker/wrangler.toml.template > worker/wrangler.toml

# Hash admin password and write to KV
HASH=$(node -e "const b=require('bcryptjs');console.log(b.hashSync('$PASS',10))")
wrangler kv key put --binding=KV "auth:password" "$HASH"

# Persist config (no password stored)
cat > "$CONFIG_FILE" <<EOF
DB_NAME=$DB_NAME
KV_NAME=$KV_NAME
WORKER_NAME=$WORKER_NAME
DB_ID=$DB_ID
KV_ID=$KV_ID
EOF

echo ""
echo "Setup complete. Run 'npm run deploy' to deploy."
```

#### `scripts/deploy.sh`

```bash
#!/usr/bin/env bash
set -e

if [ ! -f ".cloudtunnel.env" ]; then
  echo "Error: .cloudtunnel.env not found. Run 'npm run setup' first."
  exit 1
fi

source .cloudtunnel.env

echo "Running D1 migrations..."
wrangler d1 migrations apply "$DB_NAME"

echo "Deploying worker..."
wrangler deploy
```

#### `worker/wrangler.toml.template`

```toml
name = "{{WORKER_NAME}}"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "{{DB_NAME}}"
database_id = "{{DB_ID}}"

[[kv_namespaces]]
binding = "KV"
id = "{{KV_ID}}"
```

---

## 9. AGENTS.md Conventions

The `AGENTS.md` file lives at the repo root. Every AI agent reads it before touching any file.

```markdown
# Agent conventions

## Read this first
This file defines the rules for working in this repo.
Follow them mechanically — don't infer alternatives.

## Where things live
- New Worker route      → src/routes/{name}.ts + test/routes/{name}.test.ts
- New D1 query          → src/db/{table}.ts, never inline in a route
- New KV operation      → src/kv/{purpose}.ts, never inline in a route
- New Go feature        → internal/{feature}/{feature}.go, one package per concern
- New CF API call       → src/cf/tunnel.ts (extend, don't create new files)

## Dependency rules
- Routes never import other routes
- Routes never call D1 or KV directly — always go through db/ or kv/
- db/ and kv/ packages never import from routes/
- types.ts is the only file importable across all packages
- Every route file exports exactly one handler function

## Types
- worker/src/types.ts and dashboard/src/types.ts are separate copies
- When changing an API shape: update schema/api.ts first,
  then sync worker and dashboard types manually
- Never import across worker/ and dashboard/ boundaries

## Config files
- .cloudtunnel.env — gitignored, generated by setup.sh, sourced by deploy.sh
- wrangler.toml — gitignored, generated from wrangler.toml.template by setup.sh
- Never hardcode DB_NAME, KV_NAME, or WORKER_NAME anywhere in source
- To change a resource name: edit .cloudtunnel.env and re-run setup.sh

## Adding a new Cloudflare binding
1. Add creation + idempotency check to scripts/setup.sh
2. Add {{PLACEHOLDER}} to worker/wrangler.toml.template
3. Add sed substitution to setup.sh
4. Run npm run setup to regenerate wrangler.toml

## Migrations
- New table or column → new file in worker/migrations/ with next sequence number
- Never edit an existing migration file
- migrations apply runs automatically in deploy.sh

## Testing
- Every route has a corresponding test at test/routes/{name}.test.ts
- Mock D1/KV via wrangler test helpers — never use real bindings in tests
```

---

## 10. Decisions Log

| # | Decision | Rationale |
|---|---|---|
| 1 | No session token rotation for v1 | Keeps it simple; revisit if needed |
| 2 | No config-ack / pending badge | Simplicity; last_seen is sufficient signal |
| 3 | Session token returned in `/register` response body | Avoids D1 read-after-write eventual consistency race |
| 4 | Embed `cloudflared` at pinned version, `--system-cloudflared` flag for advanced users | Controlled version, still flexible |
| 5 | Single admin password, no multi-user for v1 | Scope control; CF Access can be layered later |
| 6 | D1 for operational state, KV for secrets/blobs | D1 free tier (100k writes/day) solves liveness at 30s intervals; KV for fast secret reads |
| 7 | No Cache API for liveness | Cache API is per-datacenter; cross-region nodes would always appear offline |
| 8 | Tunnel token via `TUNNEL_TOKEN` env var, never written to disk | Avoids `/proc` exposure and disk credential risk |
| 9 | `wrangler.toml` gitignored, generated from template | Resource IDs (D1, KV) are environment-specific — not safe to commit |
| 10 | `.cloudtunnel.env` persists setup answers, password never stored | Re-runs load defaults without re-prompting; password only needed once to hash into KV |
| 11 | `worker/` and `dashboard/` types are separate copies | Prevents accidental cross-boundary coupling; schema/api.ts is the canonical source |

---

## 11. Build Milestones

| Milestone | Scope | Notes |
|---|---|---|
| M1 — Core plumbing | Worker + D1 schema + KV layout, `/register` + `/config` endpoints, session token auth | Test via curl, no Dashboard |
| M2 — Go client v1 | Register, fetch config, spawn `cloudflared` via env var, poll loop, systemd unit | Hardcode Worker URL in config |
| M3 — Dashboard v1 | Pages SPA: login, node list with liveness, ingress editor | Read-only first, then add save |
| M4 — Node lifecycle | Delete node (tunnel revoke + D1 cleanup), rename, audit log, install script | One-liner curl installer |
| M5 — Hardening | Rate limiting, backoff on `cloudflared` crash, load test 30+ nodes | Verify D1 write budget holds |

---

## 12. Out of Scope (v1)

- Windows or macOS agent support
- Metrics / observability (Prometheus, Grafana)
- Multi-tenant / per-user node isolation
- Multi-user dashboard auth (CF Access — future layer)
- Custom `cloudflared` origin TLS settings via UI
- Auto-update of the Go binary
- Real-time push config (WebSocket) — polling is sufficient

---

_CloudTunnel Manager · Internal Tech Lead Brainstorm · v0.3 · Not for distribution_