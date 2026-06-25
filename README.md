# Quick Order

Quick Order is the companion app for the dashboard. It runs on `3005` and posts
new orders to the dashboard backend.

## Run

Start the dashboard backend first:

```bash
cd ../wt-backend
npm install
npm run dev
```

Then start Quick Order:

```bash
cd ../websockets-quickorder
npm install
npm run dev
```

Open http://localhost:3005.

By default, Quick Order proxies `/api/*` to http://localhost:3004. Override that
backend target with `BACKEND_URL`:

```bash
BACKEND_URL=http://localhost:3004 npm run dev
```

The dashboard UI should be open at http://localhost:3003 during split local
development. Creating an order in Quick Order should move the new row to the top
of the dashboard list and refresh the aggregates through SSE.

## Verify

```bash
npm run lint
```
