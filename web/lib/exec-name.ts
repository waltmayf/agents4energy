// Step Functions caps execution names at 80 chars. The name is
// `<prefix>-<runId>`, where the PREFIX is also the shared match key
// `agent-webhook-receiver`'s cancelPriorRuns() uses (via ListExecutions) to
// find every run for the same repo/issue/Jira-key (issue #182) — so unlike
// the original fix (#200, which truncated the prefix), the full `<prefix>-`
// must stay intact and the runId side gets shortened instead. Hash the runId
// down to a short, still-effectively-unique suffix when the full name would
// overflow. Without some truncation, long repo names (e.g.
// aws-samples/sample-edge-to-cloud-digital-ops-workshop) make StartExecution
// throw ValidationException and the webhook 500s.
import { createHash } from 'crypto';

const MAX_LEN = 80;
const MIN_SUFFIX_LEN = 8;

export function execName(prefix: string, runId: string): string {
  const full = `${prefix}-${runId}`;
  if (full.length <= MAX_LEN) return full;

  const hashedRunId = createHash('sha256').update(runId).digest('hex');
  if (prefix.length + 1 + MIN_SUFFIX_LEN <= MAX_LEN) {
    const suffixLen = MAX_LEN - prefix.length - 1;
    return `${prefix}-${hashedRunId.slice(0, suffixLen)}`;
  }
  // Pathological case: the prefix alone doesn't leave room for even the
  // minimum suffix. Truncating the prefix is unavoidable here (no naming
  // scheme fits both under 80 chars) — cancelPriorRuns' prefix match then only
  // degrades for this one execution, not the general case.
  const suffix = `-${hashedRunId.slice(0, MIN_SUFFIX_LEN)}`;
  return `${prefix.slice(0, MAX_LEN - suffix.length)}${suffix}`;
}

// The shared match key for every execution started for the same target
// (repo+issueNumber, or Jira issueKey) — always `${base}-`, and always kept
// fully intact by execName above regardless of truncation. cancelPriorRuns
// uses this to find every RUNNING execution for the same target before
// starting a new one (last-write-wins, issue #182).
export function sharedNamePrefix(base: string): string {
  return `${base}-`;
}
