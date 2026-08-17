'use client';
import { useCallback, useEffect, useState } from 'react';

/**
 * Per-user "have I consented?" status for an MCP server's outbound OAuth (3LO)
 * credential provider — epic #412 slice 7 (#419).
 *
 * The vaulted 3LO token itself lives inside AgentCore Identity, keyed by the
 * signed-in user, and is injected outbound by the gateway (see slice 1/#413 +
 * the gateway target's credentialProviderConfigurations). There is no
 * frontend-readable "is this user authenticated for this provider" API — the
 * only authoritative signal is a live `tools/call` through the gateway, which
 * returns the `-32042` elicitation (slice 4/#416) when no token is vaulted yet.
 * That call only happens on the chat path, where `McpElicitationBanner`
 * (slices 4/5) completes consent via `completeResourceTokenAuth`.
 *
 * So the MCP Servers panel tracks a best-effort per-(user, server) hint in
 * localStorage: it records when this browser last completed / observed consent
 * for a server, and an optional expiry, so the panel can render
 * Authenticated / Needs auth / Expired without a backend read. It defaults to
 * `needs-auth` for a configured 3LO server (correct for a first-time user),
 * and is refreshed whenever the tab regains focus (mirroring use-agents.ts) so
 * a consent completed in the chat tab is reflected here on return.
 */
export type OutboundAuthStatus = 'authenticated' | 'needs-auth' | 'expired';

interface StoredRecord {
  status: 'authenticated' | 'needs-auth';
  /** ISO-8601; when present and in the past, the effective status is `expired`. */
  expiresAt?: string | null;
  updatedAt: string;
}

const KEY_PREFIX = 'a4e:outbound-3lo';

function storageKey(sub: string, serverId: string): string {
  return `${KEY_PREFIX}:${sub}:${serverId}`;
}

function readRecord(sub: string | null, serverId: string): StoredRecord | null {
  if (!sub || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(sub, serverId));
    return raw ? (JSON.parse(raw) as StoredRecord) : null;
  } catch {
    return null;
  }
}

function writeRecord(sub: string | null, serverId: string, record: StoredRecord | null): void {
  if (!sub || typeof window === 'undefined') return;
  try {
    if (record) window.localStorage.setItem(storageKey(sub, serverId), JSON.stringify(record));
    else window.localStorage.removeItem(storageKey(sub, serverId));
  } catch {
    /* localStorage may be unavailable (private mode) — status is best-effort. */
  }
}

function deriveStatus(record: StoredRecord | null): OutboundAuthStatus {
  if (!record || record.status !== 'authenticated') return 'needs-auth';
  if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) return 'expired';
  return 'authenticated';
}

/** Record that this user has completed (or observed) consent for a server. */
export function markOutboundAuthenticated(
  sub: string | null,
  serverId: string,
  expiresAt?: string | null,
): void {
  writeRecord(sub, serverId, { status: 'authenticated', expiresAt: expiresAt ?? null, updatedAt: new Date().toISOString() });
}

/** React hook exposing the best-effort per-user status for one server. */
export function useOutboundAuthStatus(sub: string | null, serverId: string | null) {
  // `status` is derived on every render straight from localStorage (cheap,
  // window-guarded for SSR) so it re-reads whenever `sub`/`serverId` change —
  // no synchronous setState in an effect. `tick` only forces a re-read after a
  // focus event or an explicit mark, where setState lives in a callback.
  const [tick, setTick] = useState(0);
  void tick;

  useEffect(() => {
    function onFocus() { setTick((t) => t + 1); }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const status: OutboundAuthStatus = serverId ? deriveStatus(readRecord(sub, serverId)) : 'needs-auth';

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const markAuthenticated = useCallback((expiresAt?: string | null) => {
    if (!serverId) return;
    markOutboundAuthenticated(sub, serverId, expiresAt);
    setTick((t) => t + 1);
  }, [sub, serverId]);

  return { status, refresh, markAuthenticated };
}
