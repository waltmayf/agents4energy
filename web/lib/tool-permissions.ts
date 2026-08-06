import { generateClient } from 'aws-amplify/data';
import type { Schema } from '@/amplify/data/resource';

const amplifyClient = generateClient<Schema>({ authMode: 'userPool' });

export type ToolGrantEffect = 'ALLOW' | 'DENY';

export type ToolGrant = {
  group: string;
  mcpServerId: string;
  toolName: string;
  effect: ToolGrantEffect;
};

/** Fetches every GroupToolGrant row, paging through nextToken. */
export async function listAllToolGrants(): Promise<ToolGrant[]> {
  const all: ToolGrant[] = [];
  let nextToken: string | undefined;
  do {
    const res = await amplifyClient.models.GroupToolGrant.list(nextToken ? { nextToken } : {});
    for (const g of res.data ?? []) {
      all.push({
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
 * Non-authoritative UX check: is `toolName` on `mcpServerId` granted to any of
 * `userGroups`? A DENY for a group always wins over an ALLOW for the same
 * group; "*" grants match every tool name. Absence of any matching grant
 * (for any of the user's groups) means hidden — this is a defense-in-depth UX
 * filter only, not enforcement (see #248 for the real boundary via Cedar).
 */
export function isToolGrantedToAnyGroup(
  grants: ToolGrant[],
  userGroups: string[],
  mcpServerId: string,
  toolName: string,
): boolean {
  if (userGroups.length === 0) return false;
  const relevant = grants.filter(
    (g) => g.mcpServerId === mcpServerId && userGroups.includes(g.group) && (g.toolName === toolName || g.toolName === '*'),
  );
  if (relevant.length === 0) return false;
  if (relevant.some((g) => g.effect === 'DENY')) return false;
  return relevant.some((g) => g.effect === 'ALLOW');
}
