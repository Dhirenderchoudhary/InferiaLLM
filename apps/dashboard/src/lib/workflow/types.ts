export type PortType = "audio" | "text";

export type NodeKind =
  | "audioInput"
  | "textInput"
  | "speechToText"
  | "llm"
  | "textToSpeech"
  | "textOutput"
  | "audioOutput";

export type Payload = { type: "text"; text: string } | { type: "audio"; blob: Blob };

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  position: { x: number; y: number };
  config: Record<string, string>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

export interface Workflow {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export type NodeStatus = "idle" | "running" | "done" | "error";

export interface NodeRun {
  status: NodeStatus;
  // performance.now() when the node's own work began, so the UI can tick a live timer.
  startedAt?: number;
  ms?: number;
  output?: Payload;
  error?: string;
}

export interface RunContext {
  baseUrl: string;
  token: string | null;
  fetch: typeof fetch;
  // Recorded/uploaded audio lives outside the workflow because Blobs are not serializable.
  audioInputs: Record<string, Blob>;
}
