import React from 'react';

/** Simple table widget rendering a spec with type 'table' and a `data` array of objects. */
export const TableWidget: React.FC<{ spec: { data: Array<Record<string, unknown>> } }> = ({ spec }) => {
  const { data } = spec;
  if (!Array.isArray(data) || data.length === 0) return <div>No data</div>;
  const headers = Object.keys(data[0]);
  return (
    <table className="w-full border-collapse border">
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h} className="border px-2 py-1 text-left bg-muted">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => (
          <tr key={i}>
            {headers.map((h) => (
              <td key={h} className="border px-2 py-1">
                {String(row[h] ?? '')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** Simple metric‑grid widget rendering a spec with type 'metric-grid' and a `data` array of {label,value}. */
export const MetricGridWidget: React.FC<{ spec: { data: Array<{ label: string; value: unknown }> } }> = ({ spec }) => {
  const { data } = spec;
  if (!Array.isArray(data) || data.length === 0) return <div>No metrics</div>;
  return (
    <div className="grid grid-cols-2 gap-4">
      {data.map((m, i) => (
        <div key={i} className="rounded border p-2 bg-background">
          <div className="text-xs text-muted-foreground">{m.label}</div>
          <div className="text-lg font-medium">{String(m.value)}</div>
        </div>
      ))}
    </div>
  );
};

/** Registry mapping spec.type to a React component. */
export const widgetRegistry: Record<string, React.FC<{ spec: any }>> = {
  table: TableWidget,
  'metric-grid': MetricGridWidget,
};
