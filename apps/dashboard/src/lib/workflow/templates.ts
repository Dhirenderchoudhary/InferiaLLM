import type { Deployment } from "@/hooks/useReadyDeployments";
import { NODE_KINDS, matchingDeployments } from "./nodeKinds";
import type { NodeKind, Workflow } from "./types";

export const BANKING_SYSTEM_PROMPT = `You are the voice assistant for Inferia Bank, a fictional bank used for a product demo. Your answers are spoken aloud, so reply in one to three short sentences with no markdown or lists.
Only use the customer data below and never invent figures. Help with balances, recent transactions, blocking the card, and branch hours. Never ask for full card numbers, PINs, or passwords.

Customer: Alex Morgan
Checking balance: $4,820.55
Savings balance: $12,350.00
Card status: active
Recent transactions: Oct 21 Grocery Mart -$86.40; Oct 20 Salary deposit +$3,200.00; Oct 19 Metro Transit -$45.00; Oct 18 Cafe Lumen -$12.75; Oct 16 Electric Utility -$118.20
Branch hours: Monday to Friday 9 AM to 5 PM, Saturday 9 AM to 1 PM, closed Sunday.`;

function chain(steps: Array<{ kind: NodeKind; config?: Record<string, string> }>): Workflow {
  const nodes = steps.map((s, i) => ({
    id: `${s.kind}-${i + 1}`,
    kind: s.kind,
    // Wrap after three columns so the voice pipeline stays legible at fit-view zoom.
    position: { x: (i % 3) * 270, y: Math.floor(i / 3) * 360 },
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
        { kind: "textToSpeech", config: { voice: "af_heart" } },
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

// Fill empty model fields with the first matching ready deployment.
export function autofillModels(workflow: Workflow, deployments: Deployment[]): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const config = { ...node.config };
      for (const field of NODE_KINDS[node.kind].fields) {
        if (field.type !== "model" || config[field.key]) continue;
        const match = matchingDeployments(field, deployments)[0];
        if (match) config[field.key] = match.modelName;
      }
      return { ...node, config };
    }),
  };
}
