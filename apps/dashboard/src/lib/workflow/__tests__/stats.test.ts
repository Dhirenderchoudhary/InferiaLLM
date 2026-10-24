import { describe, expect, it } from "vitest";
import { formatMs, recordRuns, stats } from "../stats";

describe("stats", () => {
  it("returns null with no samples", () => {
    expect(stats([])).toBeNull();
  });

  it("uses nearest-rank percentiles and keeps the latest sample as last", () => {
    expect(stats([300, 100, 200])).toEqual({ count: 3, last: 200, p50: 200, p95: 300 });
    expect(stats([40, 10, 30, 20])).toEqual({ count: 4, last: 20, p50: 20, p95: 40 });
    expect(stats([7])).toEqual({ count: 1, last: 7, p50: 7, p95: 7 });
  });

  it("picks the 95th rank on twenty samples", () => {
    const samples = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(stats(samples)).toMatchObject({ p50: 100, p95: 190 });
  });
});

describe("recordRuns", () => {
  it("accumulates done timings per node across runs and skips failures", () => {
    let history = recordRuns({}, { stt: { status: "done", ms: 500 }, llm: { status: "error", ms: 20 } });
    history = recordRuns(history, { stt: { status: "done", ms: 600 }, llm: { status: "done", ms: 1100 } });
    history = recordRuns(history, { stt: { status: "done", ms: 550 }, tts: { status: "idle" } });
    expect(history).toEqual({ stt: [500, 600, 550], llm: [1100] });
  });

  it("keeps only the most recent samples", () => {
    let history = {};
    for (const ms of [1, 2, 3, 4]) history = recordRuns(history, { a: { status: "done", ms } }, 3);
    expect(history).toEqual({ a: [2, 3, 4] });
  });
});

describe("formatMs", () => {
  it("switches to seconds at one second", () => {
    expect(formatMs(576.4)).toBe("576 ms");
    expect(formatMs(6573)).toBe("6.6 s");
  });
});
