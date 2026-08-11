'use client';
import { useCallback, useEffect, useState } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';
import type { GraphNodeInput, GraphEdgeInput } from '@/lib/graph-layout';

const amplifyClient = generateClient<Schema>({ authMode: 'userPool' });

/** Page through an Amplify list op until every row is fetched. */
async function listAll<T>(
  fn: (opts: { nextToken?: string; limit?: number }) => Promise<{ data: T[]; nextToken?: string | null }>,
): Promise<T[]> {
  const all: T[] = [];
  let token: string | undefined;
  do {
    const res = await fn(token ? { nextToken: token, limit: 200 } : { limit: 200 });
    all.push(...(res.data ?? []));
    token = res.nextToken ?? undefined;
  } while (token);
  return all;
}

/**
 * Read `s3Path` out of a Node's free-form `props` json (set by the agent via
 * UpsertNode). Tolerates props being a string, object, null, or absent.
 */
function s3PathFromProps(props: unknown): string | null {
  let parsed: unknown = props;
  if (typeof props === 'string') {
    try {
      parsed = JSON.parse(props);
    } catch {
      return null;
    }
  }
  if (parsed && typeof parsed === 'object' && 's3Path' in parsed) {
    const value = (parsed as Record<string, unknown>).s3Path;
    return typeof value === 'string' && value.trim() ? value : null;
  }
  return null;
}

export interface KnowledgeGraph {
  nodes: GraphNodeInput[];
  edges: GraphEdgeInput[];
}

export type GraphState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; graph: KnowledgeGraph };

/**
 * Loads the entire knowledge graph (Node + Edge models) over AppSync. The graph
 * is small enough today (demo scale) to load whole and lay out client-side; if
 * it grows, switch to the TraverseGraph tool for a bounded neighbourhood.
 */
export function useKnowledgeGraph(): { state: GraphState; reload: () => void } {
  const [state, setState] = useState<GraphState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    (async () => {
      try {
        const [nodeRows, edgeRows] = await Promise.all([
          listAll((opts) => amplifyClient.models.Node.list(opts)),
          listAll((opts) => amplifyClient.models.Edge.list(opts)),
        ]);
        if (cancelled) return;
        const nodes: GraphNodeInput[] = nodeRows.map((n) => ({
          id: n.id,
          kind: n.kind,
          label: n.label,
          s3Path: s3PathFromProps(n.props),
        }));
        const edges: GraphEdgeInput[] = edgeRows.map((e) => ({
          id: e.id,
          fromId: e.fromId,
          toId: e.toId,
          type: e.type,
        }));
        setState({ status: 'ready', graph: { nodes, edges } });
      } catch (err) {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Failed to load graph' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return { state, reload };
}
