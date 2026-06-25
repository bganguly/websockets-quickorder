"use client";

import { useEffect, useRef, useState } from "react";

/** /api/regions returns `{ code, name }` (no id). The numeric `regionId` POST
 *  needs is resolved client-side: authoritatively from the `region.id` on
 *  /api/orders rows, falling back to the numeric suffix of the code (codes are
 *  `R<id>`, e.g. "R4" → 4). */
interface RegionRow {
  id?: number;
  code: string;
  name: string;
}

interface CustomerOption {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
}

/** Parse the numeric id out of a region code like "R4" → 4. */
function regionIdFromCode(code: string): number | null {
  const m = code.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

const PRODUCT_MAX = 4_000;
const NOAH_FRANK = {
  id: 63098,
  email: "customer63098@example.com",
  firstName: "Noah",
  lastName: "Frank",
};

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPrice(): string {
  return (Math.random() * 90 + 10).toFixed(2); // 10.00 – 100.00
}

const fieldCls =
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";
const labelCls = "block space-y-1 text-xs font-medium text-gray-600";

function customerLabel(c: CustomerOption): string {
  return `${c.firstName} ${c.lastName}`.trim() || c.email;
}

export default function QuickOrderPage() {
  const [customerId, setCustomerId] = useState(NOAH_FRANK.id);
  const [selectedCustomer, setSelectedCustomer] =
    useState<CustomerOption>(NOAH_FRANK);
  const [customerQuery, setCustomerQuery] = useState(customerLabel(NOAH_FRANK));
  const [customerResults, setCustomerResults] = useState<CustomerOption[]>([]);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [customerDirty, setCustomerDirty] = useState(false);
  const customerListboxId = "quick-order-customer-listbox";
  const [productId, setProductId] = useState(() => randInt(1, PRODUCT_MAX));
  const [regions, setRegions] = useState<RegionRow[]>([]);
  const [regionCode, setRegionCode] = useState("");
  // Authoritative code -> id map, discovered from /api/orders region rows.
  const [regionIdByCode, setRegionIdByCode] = useState<Record<string, number>>(
    {},
  );
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState(randomPrice);
  const [notes, setNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCustomerSearch = useRef(customerQuery.trim().toLowerCase());

  // Load regions on mount; default to the first option.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/regions")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data: RegionRow[]) => {
        if (cancelled || !Array.isArray(data)) return;
        setRegions(data);
        if (data.length > 0) setRegionCode(data[0].code);
      })
      .catch(() => {
        /* leave regions empty; submit stays guarded */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const q = customerQuery.trim();
    const key = q.toLowerCase();
    if (!customerDirty || q.length < 2 || key === lastCustomerSearch.current) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      lastCustomerSearch.current = key;
      setCustomerLoading(true);
      fetch(`/api/customers?q=${encodeURIComponent(q)}&limit=8`, {
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
        .then((json) => {
          const rows: CustomerOption[] = Array.isArray(json?.data)
            ? json.data
            : [];
          setCustomerResults(rows);
          setCustomerDirty(false);
        })
        .catch((err) => {
          if ((err as Error).name !== "AbortError") setCustomerResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setCustomerLoading(false);
        });
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [customerDirty, customerQuery]);

  // Build an authoritative code -> id map from a page of orders (region rows
  // carry the real id). Best-effort; the code-suffix fallback covers the rest.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/orders?pageSize=100")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((json) => {
        if (cancelled) return;
        const rows: Array<{ region?: { id?: number; code?: string } }> =
          Array.isArray(json?.data) ? json.data : [];
        const map: Record<string, number> = {};
        for (const row of rows) {
          const rg = row.region;
          if (rg?.code && typeof rg.id === "number") map[rg.code] = rg.id;
        }
        if (Object.keys(map).length) setRegionIdByCode(map);
      })
      .catch(() => {
        /* fall back to code-suffix parsing */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  const resolveRegionId = (code: string): number | null =>
    regionIdByCode[code] ?? regionIdFromCode(code);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const regionId = regionCode ? resolveRegionId(regionCode) : null;
    if (regionId == null) {
      setError("Pick a region.");
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        customerId,
        regionId,
        currency: "USD",
        notes: notes.trim() || null,
        items: [
          {
            productId,
            quantity: Number(quantity),
            unitPrice: Number(unitPrice),
            discount: 0,
          },
        ],
      };
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const msg = await res
          .json()
          .then((j) => j?.error as string | undefined)
          .catch(() => undefined);
        throw new Error(msg || `Request failed (HTTP ${res.status})`);
      }
      const created = await res.json().catch(() => null);
      setFlash(created?.id ? `Order #${created.id} created` : "Order created");
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), 3000);

      setProductId(randInt(1, PRODUCT_MAX));
      setUnitPrice(randomPrice());
      setNotes("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <header className="mb-5">
          <h1 className="text-lg font-semibold text-gray-900">Quick Order</h1>
          <p className="text-xs text-gray-500">
            Submit an order — the dashboard on :3003 reloads live.
          </p>
        </header>

        <form
          data-testid="quick-order-form"
          onSubmit={handleSubmit}
          className="space-y-4"
        >
          <label className={labelCls}>
            Customer
            <div className="relative">
              <input
                type="search"
                data-testid="quick-order-customer-search"
                value={customerQuery}
                onChange={(e) => {
                  const next = e.target.value;
                  setCustomerQuery(next);
                  setCustomerDirty(true);
                  setCustomerOpen(true);
                  if (next.trim().length < 2) {
                    setCustomerResults([]);
                    setCustomerLoading(false);
                  }
                }}
                onFocus={() => setCustomerOpen(true)}
                onBlur={() => setTimeout(() => setCustomerOpen(false), 120)}
                placeholder="Search customer name or email"
                role="combobox"
                aria-controls={customerListboxId}
                aria-expanded={customerOpen}
                className={fieldCls}
              />
              {customerOpen && (
                <div
                  id={customerListboxId}
                  role="listbox"
                  className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg"
                >
                  {customerLoading && customerDirty ? (
                    <p className="px-3 py-2 text-sm text-gray-400">Searching...</p>
                  ) : customerResults.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-gray-400">
                      Type at least 2 letters.
                    </p>
                  ) : (
                    customerResults.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        role="option"
                        aria-selected={c.id === customerId}
                        data-testid="quick-order-customer-option"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setSelectedCustomer(c);
                          setCustomerId(c.id);
                          setCustomerDirty(false);
                          lastCustomerSearch.current = customerLabel(c)
                            .trim()
                            .toLowerCase();
                          setCustomerQuery(customerLabel(c));
                          setCustomerOpen(false);
                        }}
                        className="flex w-full flex-col px-3 py-2 text-left text-sm hover:bg-indigo-50"
                      >
                        <span className="font-medium text-gray-900">
                          {customerLabel(c)}
                        </span>
                        <span className="text-xs text-gray-500">
                          #{c.id} · {c.email}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <span className="text-xs font-normal text-indigo-600">
              Selected: {customerLabel(selectedCustomer)} #{customerId}
            </span>
          </label>

          <label className={labelCls}>
            Region
            <select
              value={regionCode}
              onChange={(e) => setRegionCode(e.target.value)}
              className={fieldCls}
            >
              {regions.length === 0 && <option value="">Loading…</option>}
              {regions.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.name || r.code}
                </option>
              ))}
            </select>
          </label>

          <label className={labelCls}>
            Product ID
            <input
              type="number"
              min={1}
              max={PRODUCT_MAX}
              value={productId}
              onChange={(e) => setProductId(Number(e.target.value))}
              className={fieldCls}
            />
          </label>

          <label className={labelCls}>
            Quantity
            <input
              type="number"
              min={1}
              step={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className={fieldCls}
            />
          </label>

          <label className={labelCls}>
            Unit Price
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
              className={fieldCls}
            />
          </label>

          <label className={labelCls}>
            Notes
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="optional notes"
              className={fieldCls}
            />
          </label>

          <button
            type="submit"
            data-testid="quick-order-submit"
            disabled={submitting}
            className="w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Adding…" : "Add Order"}
          </button>

          {flash && (
            <p
              data-testid="quick-order-flash"
              role="status"
              className="rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700"
            >
              {flash}
            </p>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {error}
            </p>
          )}
        </form>
      </div>
    </main>
  );
}
