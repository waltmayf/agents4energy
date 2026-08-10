/**
 * Materializes `ChatSession.lineageSummary` (the per-session "consolidated
 * list of datasets accessed during the session") into the knowledge graph
 * (issue #292). Pluggable-ingestion-source pattern: this module knows only
 * how to turn a `ChatSession` row into upsertNode/upsertEdge calls via the
 * storage-agnostic helpers in graph-write.ts — a future S3-listing or
 * energy-domain source would be a sibling module with the same shape, not a
 * change to this one.
 */

import { upsertNode, upsertEdge, type SignedGraphqlRequest } from './graph-write.ts';

/**
 * `lineageSummary` is stored as free-form JSON (`a.json()` on ChatSession) —
 * no writer exists yet, so this accepts the reasonable shapes a future writer
 * would produce: an array of entries, each either a bare path/name string or
 * an object carrying at least a name/path/id and optionally a kind.
 */
export type LineageEntry =
  | string
  | {
      id?: string;
      name?: string;
      path?: string;
      kind?: string;
      [key: string]: unknown;
    };

function entryLabel(entry: LineageEntry): string | undefined {
  if (typeof entry === 'string') return entry;
  return entry.path ?? entry.name ?? entry.id;
}

function entryKind(entry: LineageEntry): string {
  if (typeof entry === 'string') return 'dataset';
  return typeof entry.kind === 'string' && entry.kind.length > 0 ? entry.kind : 'dataset';
}

function entryProps(entry: LineageEntry): Record<string, unknown> | undefined {
  if (typeof entry === 'string') return undefined;
  const { kind: _kind, ...rest } = entry;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Normalizes whatever `ChatSession.lineageSummary` currently holds into a de-duplicated entry list. */
export function parseLineageSummary(raw: unknown): LineageEntry[] {
  const items: unknown[] = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const entries: LineageEntry[] = [];

  for (const item of items) {
    let entry: LineageEntry | undefined;
    if (typeof item === 'string') entry = item;
    else if (item && typeof item === 'object') entry = item as LineageEntry;
    if (!entry) continue;

    const label = entryLabel(entry);
    if (!label) continue;

    const key = `${entryKind(entry)}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }

  return entries;
}

export interface IngestLineageResult {
  sessionNodeId: string;
  datasetNodeIds: string[];
  edgeIds: string[];
}

/**
 * Upserts a `session` node for `sessionId`, a node per lineage entry, and an
 * `accessed_in_session` edge from each dataset/document node to the session
 * node. Idempotent: re-running with the same lineageSummary produces no new
 * rows (graph-write.ts's natural-key + (fromId,toId,type) de-dup).
 */
export async function ingestLineageSummary(
  request: SignedGraphqlRequest,
  sessionId: string,
  lineageSummary: unknown,
): Promise<IngestLineageResult> {
  const entries = parseLineageSummary(lineageSummary);

  const session = await upsertNode(request, {
    kind: 'session',
    label: sessionId,
    props: { naturalKey: `session:${sessionId}` },
  });

  const datasetNodeIds: string[] = [];
  const edgeIds: string[] = [];

  for (const entry of entries) {
    const label = entryLabel(entry)!;
    const node = await upsertNode(request, { kind: entryKind(entry), label, props: entryProps(entry) });
    datasetNodeIds.push(node.id);

    const edge = await upsertEdge(request, {
      fromId: node.id,
      toId: session.id,
      type: 'accessed_in_session',
    });
    edgeIds.push(edge.id);
  }

  return { sessionNodeId: session.id, datasetNodeIds, edgeIds };
}
