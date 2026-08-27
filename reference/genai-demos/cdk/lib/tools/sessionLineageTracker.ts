import type { LineageDataset } from '../lineage/lineageTypes';

/**
 * In-memory tracker that accumulates lineage datasets per chat session.
 * Deduplicates datasets by `namespace:name` key so that repeated references
 * to the same table across multiple tool invocations are only recorded once.
 */
export class SessionLineageTracker {
  private sessions: Map<string, Map<string, LineageDataset>> = new Map();

  /** Build the deduplication key for a dataset. */
  private static datasetKey(dataset: LineageDataset): string {
    return `${dataset.namespace}:${dataset.name}`;
  }

  /**
   * Register one or more datasets for a session.
   * Duplicates (same namespace + name) are silently ignored.
   */
  addDatasets(sessionId: string, datasets: LineageDataset[]): void {
    let datasetMap = this.sessions.get(sessionId);
    if (!datasetMap) {
      datasetMap = new Map<string, LineageDataset>();
      this.sessions.set(sessionId, datasetMap);
    }
    for (const ds of datasets) {
      const key = SessionLineageTracker.datasetKey(ds);
      if (!datasetMap.has(key)) {
        datasetMap.set(key, ds);
      }
    }
  }

  /**
   * Return the consolidated, deduplicated list of datasets for a session.
   * Returns an empty array if the session has no recorded datasets.
   */
  getSummary(sessionId: string): LineageDataset[] {
    const datasetMap = this.sessions.get(sessionId);
    if (!datasetMap) return [];
    return Array.from(datasetMap.values());
  }

  /** Remove all tracked datasets for a session. */
  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/** Singleton instance shared across the agent server process. */
export const sessionLineageTracker = new SessionLineageTracker();
