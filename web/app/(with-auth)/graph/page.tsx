'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node as FlowNode,
  type Edge as FlowEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getUrl } from 'aws-amplify/storage';
import { layoutGraph, type PositionedNode } from '@/lib/graph-layout';
import { resolveS3Path, S3FsPathError } from '@/lib/s3-fs-path';
import { useKnowledgeGraph } from './use-knowledge-graph';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Separator } from '@/components/ui/separator';
import {
  FileIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  NetworkIcon,
  AlertCircleIcon,
} from 'lucide-react';

// A muted, distinct colour per common node kind; anything else falls back to a
// neutral slate. Kept deliberately small — `kind` is free-form, so this is a
// legibility aid, not an enum.
const KIND_COLORS: Record<string, string> = {
  well: '#b45309', // amber-700
  field: '#0f766e', // teal-700
  document: '#1d4ed8', // blue-700
  dataset: '#7c3aed', // violet-700
  session: '#be185d', // pink-700
};

function colorForKind(kind: string): string {
  return KIND_COLORS[kind] ?? '#475569'; // slate-600
}

function toFlowNodes(positioned: PositionedNode[], selectedId: string | null): FlowNode[] {
  return positioned.map((n) => ({
    id: n.id,
    position: { x: n.x, y: n.y },
    data: { label: `${n.label || n.kind}${n.s3Path ? ' 📎' : ''}` },
    style: {
      background: colorForKind(n.kind),
      color: 'white',
      border: n.id === selectedId ? '3px solid #f59e0b' : '1px solid rgba(255,255,255,0.4)',
      borderRadius: 8,
      fontSize: 12,
      padding: '6px 10px',
      width: 'auto',
    },
  }));
}

function toFlowEdges(edges: { id: string; fromId: string; toId: string; type: string }[]): FlowEdge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.fromId,
    target: e.toId,
    label: e.type,
    animated: false,
    style: { stroke: '#94a3b8' },
    labelStyle: { fontSize: 10, fill: '#64748b' },
  }));
}

export default function KnowledgeGraphPage() {
  const { state, reload } = useKnowledgeGraph();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const positioned = useMemo<PositionedNode[]>(() => {
    if (state.status !== 'ready') return [];
    return layoutGraph(state.graph.nodes, state.graph.edges);
  }, [state]);

  const selected = useMemo(
    () => positioned.find((n) => n.id === selectedId) ?? null,
    [positioned, selectedId],
  );

  const flowNodes = useMemo(() => toFlowNodes(positioned, selectedId), [positioned, selectedId]);
  const flowEdges = useMemo(
    () => (state.status === 'ready' ? toFlowEdges(state.graph.edges) : []),
    [state],
  );

  const openLinkedFile = useCallback(async (s3Path: string) => {
    setOpening(true);
    setOpenError(null);
    try {
      // props.s3Path is `files/`-relative; resolve to the concrete S3 key.
      const key = resolveS3Path(s3Path);
      const { url } = await getUrl({ path: key, options: { validateObjectExistence: true } });
      window.open(url.toString(), '_blank', 'noopener,noreferrer');
    } catch (err) {
      const message =
        err instanceof S3FsPathError
          ? `Invalid file path: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Could not open the linked file';
      setOpenError(message);
    } finally {
      setOpening(false);
    }
  }, []);

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-2">
          <NetworkIcon className="size-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Knowledge Graph</h1>
          {state.status === 'ready' && (
            <span className="text-sm text-muted-foreground">
              {state.graph.nodes.length} nodes · {state.graph.edges.length} edges
            </span>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={reload} disabled={state.status === 'loading'}>
          <RefreshCwIcon className="size-4" />
          Refresh
        </Button>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {state.status === 'loading' && (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Spinner /> <span className="ml-2">Loading graph…</span>
            </div>
          )}

          {state.status === 'error' && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-destructive">
              <AlertCircleIcon className="size-6" />
              <p className="text-sm">{state.message}</p>
              <Button variant="outline" size="sm" onClick={reload}>
                Retry
              </Button>
            </div>
          )}

          {state.status === 'ready' && state.graph.nodes.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <NetworkIcon className="size-8" />
              <p className="text-sm">
                The knowledge graph is empty. The agent populates it with the{' '}
                <code className="rounded bg-muted px-1">UpsertNode</code> /{' '}
                <code className="rounded bg-muted px-1">UpsertEdge</code> tools.
              </p>
            </div>
          )}

          {state.status === 'ready' && state.graph.nodes.length > 0 && (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              onNodeClick={(_, node) => {
                setSelectedId(node.id);
                setOpenError(null);
              }}
              onPaneClick={() => setSelectedId(null)}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls />
              <MiniMap pannable zoomable nodeColor={(n) => (n.style?.background as string) ?? '#475569'} />
            </ReactFlow>
          )}
        </div>

        {selected && (
          <aside className="w-80 shrink-0 overflow-y-auto border-l bg-background p-4">
            <div className="mb-2 flex items-center gap-2">
              <span
                className="inline-block size-3 rounded-full"
                style={{ background: colorForKind(selected.kind) }}
              />
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {selected.kind}
              </span>
            </div>
            <h2 className="mb-1 break-words text-base font-semibold">{selected.label || selected.id}</h2>
            <p className="mb-3 break-all text-xs text-muted-foreground">{selected.id}</p>

            <Separator className="my-3" />

            {selected.s3Path ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="break-all">{selected.s3Path}</span>
                </div>
                <Button
                  className="w-full"
                  size="sm"
                  disabled={opening}
                  onClick={() => openLinkedFile(selected.s3Path!)}
                >
                  {opening ? <Spinner /> : <ExternalLinkIcon className="size-4" />}
                  Open file
                </Button>
                {openError && (
                  <p className="flex items-start gap-1 text-xs text-destructive">
                    <AlertCircleIcon className="mt-0.5 size-3 shrink-0" />
                    {openError}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No file linked to this node. The agent can link one by setting{' '}
                <code className="rounded bg-muted px-1">props.s3Path</code> on the node.
              </p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
