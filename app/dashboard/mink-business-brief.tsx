import type { BusinessBriefResult } from "@/lib/mink/business-brief-types";

const STATUS_LABELS = {
  attention: "Needs attention",
  no_signal: "No threshold triggered",
  insufficient_data: "Not enough data",
};

export function MinkBusinessBrief({ result }: { result: BusinessBriefResult }) {
  const money = (value: number) =>
    new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: result.currency,
      maximumFractionDigits: 2,
    }).format(value);
  return (
    <section className="space-y-4 text-sm" aria-label="Business brief results">
      <div>
        <h3 className="font-semibold">
          {result.period === "weekly" ? "Weekly" : "Daily"} business brief
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {result.rangeLabel} · Compared with {result.comparisonLabel}
        </p>
        <p className="text-xs text-muted-foreground">
          {result.locationLabel} · {result.timeZone}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-2 rounded-xl border p-3">
        <div>
          <dt className="text-xs text-muted-foreground">Net sales</dt>
          <dd className="font-semibold">{money(result.netSales)}</dd>
          <dd className="text-xs">
            Previous: {money(result.previousNetSales)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Recognized orders</dt>
          <dd className="font-semibold">{result.orders}</dd>
          <dd className="text-xs">Previous: {result.previousOrders}</dd>
        </div>
      </dl>
      {result.signals.map((signal) => (
        <article
          key={signal.key}
          className={`space-y-2 rounded-xl border p-3 ${signal.status === "attention" ? "border-amber-200 bg-amber-50/60" : "border-border"}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-medium">{signal.title}</h4>
            <span className="text-xs">{STATUS_LABELS[signal.status]}</span>
          </div>
          <p>{signal.evidence}</p>
          <p className="text-xs text-muted-foreground">{signal.nextStep}</p>
          <a
            className="text-xs text-violet-700 underline underline-offset-2"
            href={
              signal.key === "sales"
                ? "/dashboard/analytics"
                : signal.key === "inventory"
                  ? "/dashboard/inventory"
                  : signal.key === "returns"
                    ? "/dashboard/orders/returns"
                    : "/dashboard/orders"
            }
          >
            Open {signal.title.toLowerCase()}
          </a>
        </article>
      ))}
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-left text-xs">
          <caption className="p-3 text-left font-medium">
            Current tracked SKUs per location
          </caption>
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="p-2">Location</th>
              <th className="p-2">Tracked</th>
              <th className="p-2">Low</th>
              <th className="p-2">Out</th>
            </tr>
          </thead>
          <tbody>
            {result.locations.map((location) => (
              <tr className="border-b last:border-0" key={location.id}>
                <th className="p-2 font-medium">
                  <a
                    className="underline underline-offset-2"
                    href={`/dashboard/inventory?location=${encodeURIComponent(location.id)}`}
                  >
                    {location.name}
                  </a>
                </th>
                <td className="p-2">{location.trackedItems}</td>
                <td className="p-2">{location.lowStock}</td>
                <td className="p-2">{location.outOfStock}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {result.locations.length === 0 && (
          <p className="p-3 text-xs">
            No accessible active physical locations.
          </p>
        )}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          Scope, evidence and limitations
        </summary>
        <ul className="mt-2 list-disc space-y-2 pl-4">
          {result.limitations.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="mt-2">
          Collected:{" "}
          {new Intl.DateTimeFormat("en-IN", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: result.timeZone,
          }).format(new Date(result.dataAsOf))}{" "}
          · {result.timeZone} · {result.rulesVersion}
        </p>
      </details>
    </section>
  );
}
