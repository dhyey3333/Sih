/**
 * Per-stage timing.
 *
 * "Client-side resource utilization" is 20% of the score and "end-to-end latency"
 * another 15%, so every stage measures itself rather than being estimated
 * afterwards. The side panel renders these live and `eval/` exports them as JSON.
 */

import type { StageTimings } from './protocol';

export type Stage = keyof StageTimings;

export class Stopwatch {
  private readonly timings: StageTimings = {};
  private readonly startedAt = performance.now();
  private marks = new Map<Stage, number>();

  start(stage: Stage): void {
    this.marks.set(stage, performance.now());
  }

  end(stage: Stage): number {
    const from = this.marks.get(stage);
    const elapsed = from === undefined ? 0 : performance.now() - from;
    this.timings[stage] = round(elapsed);
    this.marks.delete(stage);
    return elapsed;
  }

  /** Time an async step without the start/end bookkeeping. */
  async measure<T>(stage: Stage, fn: () => Promise<T> | T): Promise<T> {
    this.start(stage);
    try {
      return await fn();
    } finally {
      this.end(stage);
    }
  }

  set(stage: Stage, ms: number): void {
    this.timings[stage] = round(ms);
  }

  finish(): StageTimings {
    this.timings.total = round(performance.now() - this.startedAt);
    return { ...this.timings };
  }

  snapshot(): StageTimings {
    return { ...this.timings };
  }
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/** p50 / p95 over a series, for the eval report. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

/**
 * Heap usage, when the browser exposes it. Chrome only, and only an estimate —
 * reported as a hint beside the Task Manager numbers, never as the headline.
 */
export function heapUsedMb(): number | null {
  const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  if (!memory) return null;
  return Math.round((memory.usedJSHeapSize / 1024 / 1024) * 10) / 10;
}
