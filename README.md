# Quick Order — Next.js SSE Companion

**Next.js 16 / TypeScript** quick-order form — companion app for the
[dashboard](https://github.com/bganguly/nextjs-dashboard). Posts new orders to the dashboard backend;
the dashboard list and chart refresh live via SSE within ~100 ms.

Sister repo: [nextjs-dashboard](https://github.com/bganguly/nextjs-dashboard)

---

| | |
|---|---|
| **Next.js / TypeScript** | Next.js 16, React 19, TypeScript, Tailwind CSS |
| **Real-time integration** | POSTs to dashboard `/api/orders`; dashboard backend publishes SSE event; all open dashboard tabs refresh live |
| **BFF proxy** | `next.config.ts` rewrites `/api/*` → `BACKEND_URL/api/*` — browser sees one origin, no CORS |
| **No infra** | Stateless; no database; runs wherever Node.js runs; wired to dashboard via `BACKEND_URL` |

---

## Deploy

```bash
./scripts/deploy.sh
```

Requires the dashboard to be running first. Kills any existing process on `:3005`, builds, and starts
Quick Order on http://localhost:3005. Default backend: http://localhost:3004.

Override the dashboard URL:

```bash
BACKEND_URL=http://my-dashboard-host:3004 ./scripts/deploy.sh
```

---

## Live Service

| | URL |
|---|---|
| **Quick Order** | http://localhost:3005 |
| **Dashboard** | http://localhost:3004 (sister repo) |

### Quick test

```bash
# Check Quick Order is up
curl -I http://localhost:3005

# Verify proxy reaches the dashboard backend
curl "http://localhost:3005/api/orders?page=1&pageSize=1" | jq .total
```

---

## Tear Down

```bash
./scripts/infra-down.sh
```

Stops the Quick Order process on `:3005`. No AWS resources to destroy — this app has no infra.

---

## Architecture / Topology

```
Browser ──HTTP──► Next.js Quick Order (port 3005)
                  │ next.config.ts rewrites /api/* → BACKEND_URL
                  ▼
        Dashboard backend — bganguly/nextjs-dashboard (port 3004)
          POST /api/orders
            └─ create order in RDS
            └─ publishOrderEvent()
                 └─ /api/stream (SSE)
                      └─ all open dashboard browser tabs refresh live

Deploy flow
───────────
local machine
  └─ deploy.sh
       ├─ kill existing :3005 process (if any)
       ├─ npm install
       ├─ npm run build
       └─ npm run start  →  Quick Order on :3005
```

### Key design decisions

| Concern | Approach |
|---|---|
| **No CORS** | Next.js rewrite proxies `/api/*` to the dashboard — browser only talks to `:3005`, no cross-origin requests |
| **Real-time** | Relies on dashboard SSE (`/api/stream`) — Quick Order itself has no WebSocket or SSE server; keeps this app stateless |
| **Region resolution** | Fetches `/api/orders` on mount to build a code→id map from live region rows; falls back to numeric suffix of the region code (e.g. `R4` → 4) |
| **No infra** | Stateless by design — wired to any running dashboard instance via `BACKEND_URL`; zero AWS cost |
