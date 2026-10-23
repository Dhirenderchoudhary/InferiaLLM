import type { Deployment } from "@/hooks/useReadyDeployments";
import { NODE_KINDS } from "./nodeKinds";
import type { NodeKind, Workflow } from "./types";

export const BANKING_SYSTEM_PROMPT =
  "You are a friendly voice assistant for a retail bank. Help customers with balances, card issues, " +
  "transfers, branch hours, and loan questions. Keep answers short and conversational, since they are " +
  "spoken aloud. Never ask for full card numbers, PINs, or passwords.";

function chain(steps: Array<{ kind: NodeKind; config?: Record<string, string> }>): Workflow {
  const nodes = steps.map((s, i) => ({
    id: `${s.kind}-${i + 1}`,
    kind: s.kind,
    position: { x: i * 320, y: 0 },
    config: s.config ?? {},
  }));
  const edges = nodes.slice(1).map((n, i) => ({ id: `e-${nodes[i].id}-${n.id}`, source: nodes[i].id, target: n.id }));
  return { nodes, edges };
}

export const TEMPLATES: Record<string, { label: string; build: () => Workflow }> = {
  bankingVoice: {
    label: "Banking voice agent",
    build: () =>
      chain([
        { kind: "audioInput" },
        { kind: "speechToText" },
        { kind: "llm", config: { systemPrompt: BANKING_SYSTEM_PROMPT } },
        { kind: "textToSpeech" },
        { kind: "audioOutput" },
      ]),
  },
  textChat: {
    label: "Text chat",
    build: () =>
      chain([
        { kind: "textInput", config: { text: "What are your branch opening hours?" } },
        { kind: "llm", config: { systemPrompt: "You are a helpful assistant." } },
        { kind: "textOutput" },
      ]),
  },
};

// Fill empty model fields with the first ready deployment of the matching type.
export function autofillModels(workflow: Workflow, deployments: Deployment[]): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const config = { ...node.config };
      for (const field of NODE_KINDS[node.kind].fields) {
        if (field.type !== "model" || config[field.key]) continue;
        const candidates = deployments.filter((d) => d.model_type === field.modelType && d.modelName !== "-");
        const match = candidates.find((d) => field.prefer?.test(d.modelName)) ?? candidates[0];
        if (match) config[field.key] = match.modelName;
      }
      return { ...node, config };
    }),
  };
}
