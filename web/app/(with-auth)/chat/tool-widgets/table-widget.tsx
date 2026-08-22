import type { TableSpec } from '@/lib/component-spec';

export function TableWidget({ spec }: { spec: TableSpec }) {
  return (
    <div className="overflow-x-auto rounded border bg-background">
      {spec.title && <div className="border-b px-2 py-1 text-xs font-semibold">{spec.title}</div>}
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/50">
            {spec.columns.map((col, i) => (
              <th key={i} className="px-2 py-1 text-left font-medium">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((row, i) => (
            <tr key={i} className="border-b last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="px-2 py-1">
                  {cell === null ? '' : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
