/**
 * JSON component-spec types for the tool-result renderer (#475). A tool can
 * return a `ui` part (see `tool-result-content.ts`) carrying a `spec` object
 * instead of raw HTML; when that `spec` matches one of the shapes below, the
 * renderer shows a vetted widget instead of a YAML dump. Everything here is
 * pure/parsing logic (no React) so it stays unit-testable without a DOM.
 *
 * Adding a widget: add its spec shape + a `parseXSpec` guard here, add a case
 * to `parseComponentSpec`, then add the widget component + one registry entry
 * in `chat/tool-widgets/registry.tsx`.
 */

/** Conventional mimeType for a `ui` part whose `spec` is one of the shapes below. */
export const COMPONENT_SPEC_MIME = 'application/vnd.agents4energy.ui+json';

/** Specs or HTML blocks larger than this render as YAML instead (avoid pathological DOM/iframe payloads). */
export const MAX_SPEC_BYTES = 200_000;
export const MAX_HTML_BYTES = 200_000;

export interface TableSpec {
  type: 'table';
  title?: string;
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
}

export interface MetricGridSpec {
  type: 'metric-grid';
  title?: string;
  metrics: Array<{ label: string; value: string | number; unit?: string }>;
}

export type ComponentSpec = TableSpec | MetricGridSpec;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseTableSpec(value: unknown): TableSpec | null {
  if (!isPlainObject(value) || value.type !== 'table') return null;
  const { columns, rows, title } = value;
  if (!Array.isArray(columns) || !columns.every((c) => typeof c === 'string')) return null;
  if (!Array.isArray(rows) || !rows.every((r) => Array.isArray(r))) return null;
  return {
    type: 'table',
    columns: columns as string[],
    rows: rows as TableSpec['rows'],
    ...(typeof title === 'string' ? { title } : {}),
  };
}

export function parseMetricGridSpec(value: unknown): MetricGridSpec | null {
  if (!isPlainObject(value) || value.type !== 'metric-grid') return null;
  const { metrics, title } = value;
  if (!Array.isArray(metrics)) return null;
  const valid = metrics.every(
    (m) =>
      isPlainObject(m) &&
      typeof m.label === 'string' &&
      (typeof m.value === 'string' || typeof m.value === 'number') &&
      (m.unit === undefined || typeof m.unit === 'string'),
  );
  if (!valid) return null;
  return {
    type: 'metric-grid',
    metrics: metrics as MetricGridSpec['metrics'],
    ...(typeof title === 'string' ? { title } : {}),
  };
}

/** Try every known spec shape; returns null for anything unrecognized (renderer falls back to YAML). */
export function parseComponentSpec(value: unknown): ComponentSpec | null {
  return parseTableSpec(value) ?? parseMetricGridSpec(value);
}

/** Byte size of a value once JSON-encoded; `Infinity` if it can't be encoded (e.g. circular). */
export function jsonByteSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Infinity;
  }
}
