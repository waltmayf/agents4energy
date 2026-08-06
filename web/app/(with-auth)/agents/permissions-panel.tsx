'use client';

import { useCallback, useEffect, useState } from 'react';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { COGNITO_GROUPS } from '@/lib/cognito-groups';
import { listMcpToolsForServer } from '@/lib/list-mcp-tools';
import { ServerIcon, CheckIcon, MinusIcon, XIcon, AlertCircleIcon } from 'lucide-react';

const amplifyClient = generateClient<Schema>({ authMode: 'userPool' });

type ToolGrantEffect = 'ALLOW' | 'DENY';

type Grant = {
  id: string;
  group: string;
  mcpServerId: string;
  toolName: string;
  effect: ToolGrantEffect;
};

type McpServerOption = {
  id: string;
  name: string;
  url: string;
  oauthClientId?: string | null;
  headers: Array<{ key: string; value: string }>;
};

async function listAllGrants(): Promise<Grant[]> {
  const all: Grant[] = [];
  let nextToken: string | undefined;
  do {
    const res = await amplifyClient.models.GroupToolGrant.list(
      nextToken ? { nextToken } : {},
    );
    for (const g of res.data ?? []) {
      all.push({
        id: g.id,
        group: g.group,
        mcpServerId: g.mcpServerId,
        toolName: g.toolName,
        effect: g.effect as ToolGrantEffect,
      });
    }
    nextToken = res.nextToken ?? undefined;
  } while (nextToken);
  return all;
}

/**
 * Cycles a grant through unset -> ALLOW -> DENY -> unset for a given
 * (group, server, tool). Unset means "no row" — absence is the default deny
 * posture until #248 defines fallback behavior.
 */
function nextEffect(current: ToolGrantEffect | null): ToolGrantEffect | null {
  if (current === null) return 'ALLOW';
  if (current === 'ALLOW') return 'DENY';
  return null;
}

function GrantCell({
  effect,
  onCycle,
  saving,
}: {
  effect: ToolGrantEffect | null;
  onCycle: () => void;
  saving: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onCycle}
      disabled={saving}
      className={cn(
        'flex size-6 items-center justify-center rounded border transition-colors shrink-0',
        effect === 'ALLOW' && 'border-emerald-500/60 bg-emerald-500/15 text-emerald-600',
        effect === 'DENY' && 'border-destructive/60 bg-destructive/15 text-destructive',
        effect === null && 'border-border text-muted-foreground hover:bg-muted',
      )}
      title={effect === 'ALLOW' ? 'Allowed — click to deny' : effect === 'DENY' ? 'Denied — click to clear' : 'Unset — click to allow'}
    >
      {saving ? (
        <Spinner className="size-3" />
      ) : effect === 'ALLOW' ? (
        <CheckIcon className="size-3.5" />
      ) : effect === 'DENY' ? (
        <XIcon className="size-3.5" />
      ) : (
        <MinusIcon className="size-3.5" />
      )}
    </button>
  );
}

function ServerGrantTable({
  server,
  grants,
  onToggle,
}: {
  server: McpServerOption;
  grants: Grant[];
  onToggle: (group: string, toolName: string, current: ToolGrantEffect | null) => Promise<void>;
}) {
  const [tools, setTools] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listMcpToolsForServer(server);
      setTools(result.tools.map((t) => t.name));
      setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTools([]);
    } finally {
      setLoading(false);
    }
  }, [server]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const grantByKey = new Map(grants.map((g) => [`${g.group}::${g.toolName}`, g]));
  const rows = ['*', ...(tools ?? [])];

  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
        <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{server.name}</span>
        <span className="text-xs text-muted-foreground truncate">{server.url}</span>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-6">
          <Spinner className="size-4 text-muted-foreground" />
        </div>
      )}

      {!loading && error && (
        <p className="text-sm text-destructive bg-destructive/10 px-4 py-2 flex items-center gap-1.5">
          <AlertCircleIcon className="size-3.5 shrink-0" />
          {error}
        </p>
      )}

      {!loading && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left font-medium text-muted-foreground px-4 py-2">Tool</th>
                {COGNITO_GROUPS.map((g) => (
                  <th key={g} className="text-center font-medium text-muted-foreground px-3 py-2 whitespace-nowrap">
                    {g}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((toolName) => (
                <tr key={toolName} className="border-b last:border-b-0">
                  <td className="px-4 py-2 font-mono text-xs">
                    {toolName === '*' ? (
                      <span className="italic text-muted-foreground">* (all tools)</span>
                    ) : (
                      toolName
                    )}
                  </td>
                  {COGNITO_GROUPS.map((group) => {
                    const key = `${group}::${toolName}`;
                    const current = grantByKey.get(key)?.effect ?? null;
                    const savingThisCell = savingKey === `${server.id}::${key}`;
                    return (
                      <td key={group} className="px-3 py-2 text-center">
                        <div className="flex items-center justify-center">
                          <GrantCell
                            effect={current}
                            saving={savingThisCell}
                            onCycle={async () => {
                              setSavingKey(`${server.id}::${key}`);
                              try {
                                await onToggle(group, toolName, current);
                              } finally {
                                setSavingKey(null);
                              }
                            }}
                          />
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Admin UI for #247: view Cognito groups and toggle which MCP tools each
 * group may call, per server. Writes GroupToolGrant rows directly — server
 * enforcement of these grants is #248's job (Cedar); this page is the
 * human-editable source of truth Cedar will read from.
 */
export function PermissionsPanel({ mcpServers }: { mcpServers: McpServerOption[] }) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setGrants(await listAllGrants());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reload]);

  const handleToggle = useCallback(
    async (mcpServerId: string, group: string, toolName: string, current: ToolGrantEffect | null) => {
      const existing = grants?.find(
        (g) => g.mcpServerId === mcpServerId && g.group === group && g.toolName === toolName,
      );
      const desired = nextEffect(current);

      if (desired === null) {
        if (existing) {
          await amplifyClient.models.GroupToolGrant.delete({ id: existing.id });
        }
      } else if (existing) {
        await amplifyClient.models.GroupToolGrant.update({ id: existing.id, effect: desired });
      } else {
        await amplifyClient.models.GroupToolGrant.create({ group, mcpServerId, toolName, effect: desired });
      }
      await reload();
    },
    [grants, reload],
  );

  if (loadError) {
    return <p className="text-sm text-destructive px-6 py-6">{loadError}</p>;
  }

  if (grants === null) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  if (mcpServers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-center px-6">
        <ServerIcon className="size-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          No MCP servers configured. Add one on the MCP Servers tab first.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-6 space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Group → tool permissions</h2>
        <p className="text-sm text-muted-foreground">
          Click a cell to cycle it through unset → allow → deny → unset. This defines who <em>should</em> be
          able to call each tool; it is not yet enforced server-side (that lands with Cedar policy generation
          in a follow-up issue). The chat UI hides tools a signed-in user&apos;s groups are not granted.
        </p>
      </div>
      {mcpServers.map((server) => (
        <ServerGrantTable
          key={server.id}
          server={server}
          grants={grants.filter((g) => g.mcpServerId === server.id)}
          onToggle={(group, toolName, current) => handleToggle(server.id, group, toolName, current)}
        />
      ))}
    </div>
  );
}
