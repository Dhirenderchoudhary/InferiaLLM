import { parseThinking } from "@/lib/parseThinking";
import type { NodeKind, Payload, PortType, RunContext, WorkflowNode } from "./types";

export type ConfigField =
  | {
      key: string;
      label: string;
      type: "model";
      modelType: "inference" | "audio_generation";
      // STT and TTS share the audio_generation model_type, so the name is the only hint for auto-selection.
      prefer?: RegExp;
    }
  | { key: string; label: string; type: "text" | "textarea"; placeholder?: string };

export interface NodeKindSpec {
  label: string;
  description: string;
  input: PortType | null;
  output: PortType | null;
  fields: ConfigField[];
  run: (input: Payload | null, node: WorkflowNode, ctx: RunContext) => Promise<Payload>;
}

async function inference(ctx: RunContext, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${ctx.token ?? ""}`);
  headers.set("x-sandbox", "true");
  const res = await ctx.fetch(`${ctx.baseUrl.replace(/\/$/, "")}${path}`, { ...init, method: "POST", headers });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: unknown };
    const detail = typeof err.detail === "string" ? err.detail : undefined;
    throw new Error(detail || `API Error: ${res.status}`);
  }
  return res;
}

function expectText(input: Payload | null): string {
  if (input?.type !== "text") throw new Error("Expected text input");
  return input.text;
}

function expectAudio(input: Payload | null): Blob {
  if (input?.type !== "audio") throw new Error("Expected audio input");
  return input.blob;
}

function requireModel(node: WorkflowNode): string {
  const model = node.config.model;
  if (!model) throw new Error("Select a model");
  return model;
}

function audioFileName(blob: Blob): string {
  const subtype = blob.type.split("/")[1]?.split(";")[0];
  return `audio.${subtype === "mpeg" ? "mp3" : subtype || "webm"}`;
}

export const NODE_KINDS: Record<NodeKind, NodeKindSpec> = {
  audioInput: {
    label: "Audio input",
    description: "Record from the mic or upload a file",
    input: null,
    output: "audio",
    fields: [],
    run: async (_input, node, ctx) => {
      const blob = ctx.audioInputs[node.id];
      if (!blob) throw new Error("Record or upload audio first");
      return { type: "audio", blob };
    },
  },
  textInput: {
    label: "Text input",
    description: "A fixed text prompt",
    input: null,
    output: "text",
    fields: [{ key: "text", label: "Text", type: "textarea", placeholder: "Type a message..." }],
    run: async (_input, node) => {
      const text = node.config.text?.trim();
      if (!text) throw new Error("Enter some text");
      return { type: "text", text };
    },
  },
  speechToText: {
    label: "Speech to text",
    description: "Transcribe audio with an STT model",
    input: "audio",
    output: "text",
    fields: [
      {
        key: "model",
        label: "Model",
        type: "model",
        modelType: "audio_generation",
        prefer: /whisper|stt|asr|speech.?to.?text|transcri|recogni|parakeet/i,
      },
    ],
    run: async (input, node, ctx) => {
      const blob = expectAudio(input);
      const form = new FormData();
      form.append("file", blob, audioFileName(blob));
      form.append("model", requireModel(node));
      const res = await inference(ctx, "/v1/audio/transcriptions", { body: form });
      const data = (await res.json()) as { text?: string };
      return { type: "text", text: data.text ?? "" };
    },
  },
  llm: {
    label: "LLM",
    description: "Chat completion with a system prompt",
    input: "text",
    output: "text",
    fields: [
      { key: "model", label: "Model", type: "model", modelType: "inference" },
      { key: "systemPrompt", label: "System prompt", type: "textarea", placeholder: "You are a helpful assistant." },
    ],
    run: async (input, node, ctx) => {
      const text = expectText(input);
      const system = node.config.systemPrompt?.trim();
      const messages = [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: text },
      ];
      const res = await inference(ctx, "/v1/chat/completions", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: requireModel(node), messages }),
      });
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      };
      const message = data.choices?.[0]?.message;
      // Reasoning models inline <think> blocks; downstream TTS should only speak the answer.
      return { type: "text", text: parseThinking(message?.content ?? "", message?.reasoning_content).answer.trim() };
    },
  },
  textToSpeech: {
    label: "Text to speech",
    description: "Synthesize speech with a TTS model",
    input: "text",
    output: "audio",
    fields: [
      {
        key: "model",
        label: "Model",
        type: "model",
        modelType: "audio_generation",
        prefer: /tts|text.?to.?speech|kokoro|bark|piper|orpheus/i,
      },
      { key: "voice", label: "Voice", type: "text", placeholder: "default" },
    ],
    run: async (input, node, ctx) => {
      const text = expectText(input);
      const voice = node.config.voice?.trim();
      const res = await inference(ctx, "/v1/audio/speech", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: requireModel(node), input: text, ...(voice ? { voice } : {}) }),
      });
      return { type: "audio", blob: await res.blob() };
    },
  },
  textOutput: {
    label: "Text output",
    description: "Show the final text",
    input: "text",
    output: null,
    fields: [],
    run: async (input) => ({ type: "text", text: expectText(input) }),
  },
  audioOutput: {
    label: "Audio output",
    description: "Play the final audio",
    input: "audio",
    output: null,
    fields: [],
    run: async (input) => ({ type: "audio", blob: expectAudio(input) }),
  },
};
