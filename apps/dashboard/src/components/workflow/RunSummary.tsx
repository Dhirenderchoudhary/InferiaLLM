import { formatMs } from "@/lib/workflow/stats";
import type { NodeKind, NodeRun, Workflow } from "@/lib/workflow/types";
import { useNow } from "./useNow";

const STAGE_LABELS: Partial<Record<NodeKind, string>> = {
  videoInput: "Frames",
  speechToText: "STT",
  llm: "LLM",
  textToSpeech: "TTS",
  imageGeneration: "Image",
  vision: "Vision",
};

interface Props {
  workflow: Workflow;
  runs: Record<string, NodeRun>;
  startedAt: number;
  endedAt: number | null;
}

export function RunSummary({ workflow, runs, startedAt, endedAt }: Props) {
  const now = useNow(endedAt === null, 100);
  const elapsed = (at: number) => Math.max(0, at - startedAt);
  const total = elapsed(endedAt ?? now);

  const stages = workflow.nodes
    .filter((n) => STAGE_LABELS[n.kind] && runs[n.id]?.startedAt !== undefined)
    .map((n) => {
      const r = runs[n.id];
      const ms = r.status === "running" ? now - r.startedAt! : (r.ms ?? 0);
      return { id: n.id, label: STAGE_LABELS[n.kind]!, ms: Math.max(0, ms), startedAt: r.startedAt! };
    })
    .sort((a, b) => a.startedAt - b.startedAt);
  const stageSum = stages.reduce((sum, s) => sum + s.ms, 0);

  const audioOut = workflow.nodes.find((n) => n.kind === "audioOutput");
  const feeder = audioOut && workflow.edges.find((e) => e.target === audioOut.id);
  const fed = feeder && runs[feeder.source];
  const firstAudio =
    fed?.status === "done" && fed.startedAt !== undefined && fed.ms !== undefined
      ? elapsed(fed.startedAt + fed.ms)
      : null;

  return (
    <div className="rounded-lg border bg-background/95 px-3 py-1.5 font-mono text-xs tabular-nums shadow-sm backdrop-blur">
      <div className="flex items-baseline gap-3">
        <span>
          <span className="text-muted-foreground">total </span>
          <span className={endedAt === null ? "text-ember-500" : "font-semibold"}>{formatMs(total)}</span>
        </span>
        {audioOut && (
          <span>
            <span className="text-muted-foreground">first audio </span>
            <span className="font-semibold">{firstAudio === null ? "--" : formatMs(firstAudio)}</span>
          </span>
        )}
      </div>
      {stages.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          {stages.map((s, i) => (
            <span key={s.id}>
              {i > 0 && " · "}
              {s.label} {Math.round(s.ms)}
            </span>
          ))}
          {" = "}
          <span className="text-foreground">{formatMs(stageSum)}</span>
        </div>
      )}
    </div>
  );
}
