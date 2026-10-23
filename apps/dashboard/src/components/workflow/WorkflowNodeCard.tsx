import { useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { CheckCircle2, Loader2, Mic, Square, Upload, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { NODE_KINDS, type ConfigField } from "@/lib/workflow/nodeKinds";
import { stats } from "@/lib/workflow/stats";
import type { NodeKind, NodeRun, Payload } from "@/lib/workflow/types";
import { useCanvas } from "./canvasContext";
import { useNow } from "./useNow";

export type FlowNode = Node<{ kind: NodeKind; config: Record<string, string> }, "step">;

const inputClass =
  "nodrag w-full px-2 py-1.5 rounded-md border bg-background text-xs focus:ring-1 focus:ring-ember-500 outline-none";

export function WorkflowNodeCard({ id, data, selected }: NodeProps<FlowNode>) {
  const spec = NODE_KINDS[data.kind];
  const { runs } = useCanvas();
  const run = runs[id];

  return (
    <div
      className={cn(
        "w-60 rounded-xl border bg-card text-card-foreground shadow-sm",
        selected && "ring-2 ring-ember-500",
        run?.status === "running" && "border-ember-500",
        run?.status === "error" && "border-red-500",
      )}
    >
      {spec.input && <Handle type="target" position={Position.Left} className="!h-3 !w-3 !bg-ember-500" />}
      <NodeHeader id={id} label={spec.label} run={run} ports={`${spec.input ?? "-"} -> ${spec.output ?? "-"}`} />
      <LatencyStats nodeId={id} />
      <div className="space-y-2 p-3">
        {data.kind === "audioInput" && <AudioSource nodeId={id} />}
        {spec.fields.map((field) => (
          <Field key={field.key} nodeId={id} field={field} value={data.config[field.key] ?? ""} />
        ))}
        {run?.error && <p className="text-xs text-red-500">{run.error}</p>}
        {run?.output && data.kind !== "audioInput" && (
          <Output payload={run.output} autoPlay={data.kind === "audioOutput"} />
        )}
      </div>
      {spec.output && <Handle type="source" position={Position.Right} className="!h-3 !w-3 !bg-ember-500" />}
    </div>
  );
}

function NodeHeader({ id, label, run, ports }: { id: string; label: string; run?: NodeRun; ports: string }) {
  const { removeNode } = useCanvas();
  return (
    <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="font-mono text-[10px] text-muted-foreground">{ports}</div>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {run?.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-ember-500" />}
        {run?.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
        {run?.status === "error" && <XCircle className="h-3.5 w-3.5 text-red-500" />}
        {run && run.status !== "idle" && <Elapsed run={run} />}
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={() => removeNode(id)}
          className="nodrag rounded p-0.5 hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function Elapsed({ run }: { run: NodeRun }) {
  const live = run.status === "running";
  const now = useNow(live);
  const ms = live && run.startedAt !== undefined ? Math.max(0, now - run.startedAt) : run.ms;
  if (ms === undefined) return null;
  return (
    <span className={cn("font-mono tabular-nums", live && "text-ember-500")}>{Math.round(ms)} ms</span>
  );
}

function LatencyStats({ nodeId }: { nodeId: string }) {
  const { history } = useCanvas();
  const s = stats(history[nodeId] ?? []);
  if (!s) return null;
  return (
    <div className="flex justify-between gap-2 border-b px-3 py-1 font-mono text-[10px] tabular-nums text-muted-foreground">
      <span>last {s.last}</span>
      <span>p50 {s.p50}</span>
      <span>p95 {s.p95} ms</span>
      <span>n={s.count}</span>
    </div>
  );
}

function Field({ nodeId, field, value }: { nodeId: string; field: ConfigField; value: string }) {
  const { deployments, setConfig } = useCanvas();
  const onChange = (v: string) => setConfig(nodeId, field.key, v);

  let control;
  if (field.type === "model") {
    const options = deployments.filter((d) => d.model_type === field.modelType).map((d) => d.modelName);
    if (value && !options.includes(value)) options.unshift(value);
    control = (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        <option value="">{options.length ? "Select a model" : `No ${field.modelType} deployments`}</option>
        {options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    );
  } else if (field.type === "textarea") {
    control = (
      <textarea
        rows={3}
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(inputClass, "nowheel resize-y")}
      />
    );
  } else {
    control = (
      <input value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} className={inputClass} />
    );
  }

  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium text-muted-foreground">{field.label}</span>
      {control}
    </label>
  );
}

function AudioSource({ nodeId }: { nodeId: string }) {
  const { audioInputs, setAudio } = useCanvas();
  const [recording, setRecording] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const blob = audioInputs[nodeId];

  useEffect(() => () => recorderRef.current?.stream.getTracks().forEach((t) => t.stop()), []);

  const start = async () => {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setAudio(nodeId, new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch (err) {
      setMicError(err instanceof Error ? err.message : "Microphone unavailable");
    }
  };

  const stop = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={recording ? stop : start}
          className={cn(
            "nodrag flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-white",
            recording ? "bg-red-500 hover:bg-red-600" : "bg-ember-600 hover:bg-ember-700",
          )}
        >
          {recording ? <Square className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          {recording ? "Stop and run" : "Record"}
        </button>
        <label className="nodrag flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs hover:bg-muted">
          <Upload className="h-3.5 w-3.5" />
          Upload
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) setAudio(nodeId, file);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {recording && <p className="animate-pulse text-xs text-red-500">Recording...</p>}
      {micError && <p className="text-xs text-red-500">{micError}</p>}
      {blob && !recording && <AudioPlayer blob={blob} />}
    </div>
  );
}

function Output({ payload, autoPlay }: { payload: Payload; autoPlay: boolean }) {
  if (payload.type === "audio") return <AudioPlayer blob={payload.blob} autoPlay={autoPlay} />;
  return (
    <div className="nowheel nodrag max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 text-xs">
      {payload.text || <span className="text-muted-foreground">(empty)</span>}
    </div>
  );
}

function AudioPlayer({ blob, autoPlay = false }: { blob: Blob; autoPlay?: boolean }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <audio controls autoPlay={autoPlay} src={url} className="nodrag h-8 w-full" />;
}
