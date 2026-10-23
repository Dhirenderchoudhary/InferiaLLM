import type { NodeRun } from "./types";

export const HISTORY_LIMIT = 50;

export type History = Record<string, number[]>;

export interface Stats {
  count: number;
  last: number;
  p50: number;
  p95: number;
}

function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function stats(samples: number[]): Stats | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: samples.length,
    last: samples[samples.length - 1],
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
  };
}

export function recordRuns(history: History, runs: Record<string, NodeRun>, limit = HISTORY_LIMIT): History {
  const next = { ...history };
  for (const [id, run] of Object.entries(runs)) {
    if (run.status !== "done" || run.ms === undefined) continue;
    next[id] = [...(next[id] ?? []), run.ms].slice(-limit);
  }
  return next;
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}
