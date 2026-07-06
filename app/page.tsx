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
const MAX_BATCH_ITEMS = 5;

interface ItemDraft {
  key: string;
  customerId: number;
  customerLabel: string;
  regionCode: string;
  productId: number;
  quantity: string;
  unitPrice: string;
  notes: string;
}

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

/** Debounced /api/customers search-and-select combobox. Reused for the
 *  single entry and each batch row so every entry can pick its own customer
 *  instead of sharing one. */
function CustomerPicker({
  testId,
  selectedId,
  selectedLabel,
  onSelect,
}: {
  testId: string;
  selectedId: number;
  selectedLabel: string;
  onSelect: (c: CustomerOption) => void;
}) {
  const [query, setQuery] = useState(selectedLabel);
  const [results, setResults] = useState<CustomerOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const lastSearch = useRef(selectedLabel.trim().toLowerCase());
  const listboxId = `${testId}-listbox`;

  useEffect(() => {
    const q = query.trim();
    const key = q.toLowerCase();
    if (!dirty || q.length < 2 || key === lastSearch.current) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      lastSearch.current = key;
      setLoading(true);
      fetch(`/api/customers?q=${encodeURIComponent(q)}&limit=8`, {
        signal: controller.signal,
      })
        .then((r) =>
          r.ok ? r.json() : Promise.reject(new Error(`${r.status}`)),
        )
        .then((json) => {
          const rows: CustomerOption[] = Array.isArray(json?.data)
            ? json.data
            : [];
          setResults(rows);
          setDirty(false);
        })
        .catch((err) => {
          if ((err as Error).name !== "AbortError") setResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [dirty, query]);

  return (
    <label className={labelCls}>
      Customer
      <div className="relative">
        <input
          type="search"
          data-testid={`${testId}-search`}
          value={query}
          onChange={(e) => {
            const next = e.target.value;
            setQuery(next);
            setDirty(true);
            setOpen(true);
            if (next.trim().length < 2) {
              setResults([]);
              setLoading(false);
            }
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          placeholder="Search customer name or email"
          role="combobox"
          aria-controls={listboxId}
          aria-expanded={open}
          className={fieldCls}
        />
        {open && (
          <div
            id={listboxId}
            role="listbox"
            className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg"
          >
            {loading && dirty ? (
              <p className="px-3 py-2 text-sm text-gray-400">Searching...</p>
            ) : results.length === 0 ? (
              <p className="px-3 py-2 text-sm text-gray-400">
                Type at least 2 letters.
              </p>
            ) : (
              results.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={c.id === selectedId}
                  data-testid={`${testId}-option`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onSelect(c);
                    setDirty(false);
                    lastSearch.current = customerLabel(c).trim().toLowerCase();
                    setQuery(customerLabel(c));
                    setOpen(false);
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
    </label>
  );
}

export default function QuickOrderPage() {
  const [customerId, setCustomerId] = useState(NOAH_FRANK.id);
  const [selectedCustomer, setSelectedCustomer] =
    useState<CustomerOption>(NOAH_FRANK);
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
  const [batchItems, setBatchItems] = useState<ItemDraft[]>([]);
  const [batchExpanded, setBatchExpanded] = useState(true);
  const [batchCount, setBatchCount] = useState("1");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Dashboard reachability + "Live" checkbox state, via /api/stream/status:
  //   "live"        — dashboard is up and a tab has "Live" checked.
  //   "not-live"    — dashboard is up, but nothing has "Live" checked.
  //   "unreachable" — the dashboard app itself isn't responding at all.
  //   null          — not checked yet (assume nothing to show).
  // It has no way to push this app a signal directly (different app,
  // different browser tab/session), so polling is the only real proxy.
  type DashboardStatus = "live" | "not-live" | "unreachable" | null;
  const [dashboardStatus, setDashboardStatus] = useState<DashboardStatus>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetch("/api/stream/status")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
        .then((json: { connected?: boolean }) => {
          if (!cancelled) setDashboardStatus(json.connected ? "live" : "not-live");
        })
        .catch(() => {
          if (!cancelled) setDashboardStatus("unreachable");
        });
    };
    check();
    const interval = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

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

  function makeItemDraft(): ItemDraft {
    return {
      key: Math.random().toString(36).slice(2),
      customerId: selectedCustomer.id,
      customerLabel: customerLabel(selectedCustomer),
      regionCode: regionCode || (regions[0]?.code ?? ""),
      productId: randInt(1, PRODUCT_MAX),
      quantity: String(randInt(1, 5)),
      unitPrice: randomPrice(),
      notes: "",
    };
  }

  function setBatchEntryCount(rawCount: number) {
    const count = Math.max(
      0,
      Math.min(MAX_BATCH_ITEMS, Math.trunc(rawCount) || 0),
    );
    setBatchItems(Array.from({ length: count }, () => makeItemDraft()));
  }

  function removeBatchItem(key: string) {
    setBatchItems((prev) => prev.filter((it) => it.key !== key));
  }

  function updateBatchItem(key: string, patch: Partial<ItemDraft>) {
    setBatchItems((prev) =>
      prev.map((it) => (it.key === key ? { ...it, ...patch } : it)),
    );
  }

  async function postOrder(order: {
    customerId: number;
    regionCode: string;
    productId: number;
    quantity: string;
    unitPrice: string;
    notes: string;
  }): Promise<{ id?: number }> {
    const regionId = resolveRegionId(order.regionCode);
    if (regionId == null) throw new Error("Pick a region for every entry.");
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId: order.customerId,
        regionId,
        currency: "USD",
        notes: order.notes.trim() || null,
        items: [
          {
            productId: order.productId,
            quantity: Number(order.quantity),
            unitPrice: Number(order.unitPrice),
            discount: 0,
          },
        ],
      }),
    });
    if (!res.ok) {
      const msg = await res
        .json()
        .then((j) => j?.error as string | undefined)
        .catch(() => undefined);
      throw new Error(msg || `Request failed (HTTP ${res.status})`);
    }
    return res.json().catch(() => ({}));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!regionCode) {
      setError("Pick a region.");
      return;
    }
    setSubmitting(true);
    try {
      const orders = [
        { customerId, regionCode, productId, quantity, unitPrice, notes },
        ...batchItems.map((it) => ({
          customerId: it.customerId,
          regionCode: it.regionCode,
          productId: it.productId,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          notes: it.notes,
        })),
      ];
      const created = await Promise.all(orders.map(postOrder));
      setFlash(
        created.length > 1
          ? `${created.length} orders created`
          : created[0]?.id
            ? `Order #${created[0].id} created`
            : "Order created",
      );
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), 3000);

      setProductId(randInt(1, PRODUCT_MAX));
      setUnitPrice(randomPrice());
      setNotes("");
      setBatchItems([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4 py-8">
      <form
        data-testid="quick-order-form"
        onSubmit={handleSubmit}
        className="w-full max-w-4xl space-y-4"
      >
        <header>
          <h1 className="text-lg font-semibold text-gray-900">Quick Order</h1>
          <p className="text-xs text-gray-500">
            Submit an order — the dashboard reloads live when its
            &quot;Live&quot; checkbox is checked.
          </p>
        </header>

        {dashboardStatus === "unreachable" && (
          <div
            data-testid="quick-order-dashboard-unreachable-banner"
            className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            <p className="font-medium">The dashboard isn&apos;t available.</p>
            <p className="mt-1">
              Please bring it up and set its &quot;Live&quot; checkbox to on
              for live reload to show up on the dashboard — otherwise
              submitting won&apos;t reach it at all.
            </p>
          </div>
        )}

        {dashboardStatus === "not-live" && (
          <div
            data-testid="quick-order-dashboard-not-live-banner"
            className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            <p className="font-medium">
              The dashboard&apos;s &quot;Live&quot; checkbox isn&apos;t
              checked.
            </p>
            <p className="mt-1">
              The dashboard is up, but nothing is listening for live updates —
              check the box there, or refresh manually after submitting.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="text-sm font-semibold text-gray-900">
              Single entry
            </h2>

            <CustomerPicker
              testId="quick-order-customer"
              selectedId={customerId}
              selectedLabel={customerLabel(selectedCustomer)}
              onSelect={(c) => {
                setSelectedCustomer(c);
                setCustomerId(c.id);
              }}
            />

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
          </div>

          <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <button
              type="button"
              data-testid="quick-order-batch-toggle"
              onClick={() => setBatchExpanded((v) => !v)}
              aria-expanded={batchExpanded}
              className="flex w-full items-center justify-between text-left"
            >
              <div>
                <h2 className="text-sm font-semibold text-gray-900">
                  Batch entries
                </h2>
                <p className="text-xs text-gray-500">
                  Optional — up to {MAX_BATCH_ITEMS} additional, independent
                  orders.
                </p>
              </div>
              <span className="flex items-center gap-2 text-xs font-medium text-gray-500">
                {batchItems.length}/{MAX_BATCH_ITEMS}
                <span
                  aria-hidden
                  className={`transition-transform ${batchExpanded ? "rotate-180" : ""}`}
                >
                  ▾
                </span>
              </span>
            </button>

            {batchExpanded && (
              <>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-xs font-medium text-gray-600">
                    How many?
                    <input
                      type="number"
                      min={0}
                      max={MAX_BATCH_ITEMS}
                      step={1}
                      value={batchCount}
                      onChange={(e) => setBatchCount(e.target.value)}
                      className="w-16 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    />
                  </label>
                  <button
                    type="button"
                    data-testid="quick-order-batch-set"
                    onClick={() => setBatchEntryCount(Number(batchCount))}
                    className="rounded-md border border-indigo-200 px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
                  >
                    Set entries
                  </button>
                </div>

                <div className="space-y-3">
                  {batchItems.length === 0 ? (
                    <p className="text-xs text-gray-400">
                      No batch entries. Enter a number (up to {MAX_BATCH_ITEMS})
                      and click Set entries.
                    </p>
                  ) : (
                    batchItems.map((it, idx) => (
                      <div
                        key={it.key}
                        data-testid="quick-order-batch-row"
                        className="relative space-y-3 rounded-md border border-gray-200 bg-gray-50 p-3"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-gray-500">
                            Entry {idx + 1}
                          </span>
                          <button
                            type="button"
                            data-testid="quick-order-batch-remove"
                            aria-label="Remove entry"
                            onClick={() => removeBatchItem(it.key)}
                            className="rounded-md border border-gray-300 bg-white px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-100"
                          >
                            ×
                          </button>
                        </div>

                        <CustomerPicker
                          testId={`quick-order-batch-${idx}-customer`}
                          selectedId={it.customerId}
                          selectedLabel={it.customerLabel}
                          onSelect={(c) =>
                            updateBatchItem(it.key, {
                              customerId: c.id,
                              customerLabel: customerLabel(c),
                            })
                          }
                        />

                        <label className={labelCls}>
                          Region
                          <select
                            value={it.regionCode}
                            onChange={(e) =>
                              updateBatchItem(it.key, {
                                regionCode: e.target.value,
                              })
                            }
                            className={fieldCls}
                          >
                            {regions.length === 0 && (
                              <option value="">Loading…</option>
                            )}
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
                            value={it.productId}
                            onChange={(e) =>
                              updateBatchItem(it.key, {
                                productId: Number(e.target.value),
                              })
                            }
                            className={fieldCls}
                          />
                        </label>

                        <label className={labelCls}>
                          Quantity
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={it.quantity}
                            onChange={(e) =>
                              updateBatchItem(it.key, {
                                quantity: e.target.value,
                              })
                            }
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
                            value={it.unitPrice}
                            onChange={(e) =>
                              updateBatchItem(it.key, {
                                unitPrice: e.target.value,
                              })
                            }
                            className={fieldCls}
                          />
                        </label>

                        <label className={labelCls}>
                          Notes
                          <input
                            type="text"
                            value={it.notes}
                            onChange={(e) =>
                              updateBatchItem(it.key, { notes: e.target.value })
                            }
                            placeholder="optional notes"
                            className={fieldCls}
                          />
                        </label>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <button
          type="submit"
          data-testid="quick-order-submit"
          disabled={submitting}
          className="w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting
            ? "Adding…"
            : batchItems.length > 0
              ? `Add Orders (${batchItems.length + 1})`
              : "Add Order"}
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
    </main>
  );
}
