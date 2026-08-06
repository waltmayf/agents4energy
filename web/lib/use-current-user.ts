'use client';
import { useEffect, useState } from 'react';
import { useAuthenticator } from '@aws-amplify/ui-react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { type CallerIdentity } from './caller-identity';

/**
 * Exposes the signed-in user's Cognito `sub` + `cognito:groups` to the
 * frontend (issue #246) — the identity foundation later UI work (#247) will
 * use to hide unauthorized tools/agents. Re-reads the ID token whenever
 * `useAuthenticator`'s authStatus changes (sign-in/sign-out), since groups
 * aren't exposed as a standard user attribute.
 */
export function useCurrentUser(): CallerIdentity & { loading: boolean } {
  const { authStatus } = useAuthenticator((context) => [context.authStatus]);
  const [identity, setIdentity] = useState<CallerIdentity>({ sub: null, groups: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    if (authStatus !== 'authenticated') {
      setIdentity({ sub: null, groups: [] });
      setLoading(false);
      return;
    }

    setLoading(true);
    fetchAuthSession()
      .then((session) => {
        if (cancelled) return;
        const payload = session.tokens?.idToken?.payload;
        const sub = typeof payload?.sub === 'string' ? payload.sub : null;
        const groupsClaim = payload?.['cognito:groups'];
        const groups = Array.isArray(groupsClaim)
          ? groupsClaim.filter((g): g is string => typeof g === 'string')
          : [];
        setIdentity({ sub, groups });
      })
      .catch(() => {
        if (!cancelled) setIdentity({ sub: null, groups: [] });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authStatus]);

  return { ...identity, loading };
}
