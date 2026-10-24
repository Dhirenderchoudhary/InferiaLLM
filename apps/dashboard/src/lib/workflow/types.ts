export type PortType = "audio" | "text" | "image";

export type NodeKind =
  | "audioInput"
  | "textInput"
  | "imageInput"
  | "videoInput"
  | "speechToText"
  | "llm"
  | "textToSpeech"
  | "imageGeneration"
  | "vision"
  | "textOutput"
  | "audioOutput"
  | "imageOutput";

// A video travels as its sampled frames, so every image consumer also handles video.
export type Payload = { type: "text"; text: string } | { type: "audio"; blob: Blob } | { type: "image"; blobs: Blob[] };

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
  // Recorded/uploaded audio, images and videos live outside the workflow because Blobs are not serializable.
  inputs: Record<string, Blob>;
}
