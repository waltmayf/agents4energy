import type { MetricGridSpec } from '@/lib/component-spec';

export function MetricGridWidget({ spec }: { spec: MetricGridSpec }) {
  return (
    <div className="rounded border bg-background p-2">
      {spec.title && <div className="mb-2 text-xs font-semibold">{spec.title}</div>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {spec.metrics.map((metric, i) => (
          <div key={i} className="rounded bg-muted/50 px-2 py-1.5">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{metric.label}</div>
            <div className="text-sm font-semibold">
              {metric.value}
              {metric.unit ? <span className="ml-0.5 text-xs font-normal text-muted-foreground">{metric.unit}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
