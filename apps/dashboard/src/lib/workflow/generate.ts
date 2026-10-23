import { connectionError } from "./engine";
import { NODE_KINDS } from "./nodeKinds";
import type { ConfigField } from "./nodeKinds";
import type { NodeKind, Workflow, WorkflowNode } from "./types";

const COLUMN_WIDTH = 280;
const ROW_HEIGHT = 320;

// Only free text the user would write themselves; models and voice ids depend on what is deployed.
function plannable(field: ConfigField): boolean {
  return field.type !== "model" && !field.deploymentSpecific;
}

export function plannerPrompt(): string {
  const kinds = (Object.keys(NODE_KINDS) as NodeKind[]).map((kind) => {
    const spec = NODE_KINDS[kind];
    const config = spec.fields.filter(plannable).map((f) => `${f.key} (${f.label.toLowerCase()})`);
    return `- ${kind}: ${spec.description}. Input: ${spec.input ?? "none"}. Output: ${spec.output ?? "none"}. Config: ${config.join(", ") || "none"}.`;
  });
  return [
    "You design pipelines for a node-based workflow editor. The only node kinds are:",
    ...kinds,
    "Rules: an edge connects a node's output to another node's input of the same type. A node has at most one incoming edge. No cycles. Every node must sit on a path from an input node (no input) to an output node (no output). Use audioInput when the user speaks and audioOutput when the app talks back. Only use the config keys listed.",
    'Reply with only one JSON object, no prose and no code fences, shaped like {"nodes":[{"id":"n1","kind":"textInput","config":{"text":"Hi"}}],"edges":[{"source":"n1","target":"n2"}]}',
  ].join("\n");
}

// Models wrap JSON in prose or code fences, so take the first balanced object instead of the whole reply.
export function extractJson(text: string): unknown {
  const body = text.replace(/```(?:json)?/gi, "");
  const start = body.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(body.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Keeps every node and edge the registry and connectionError accept, and reports the rest.
export function validatePlan(raw: unknown): { workflow: Workflow; errors: string[] } {
  const errors: string[] = [];
  const workflow: Workflow = { nodes: [], edges: [] };
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return { workflow, errors: ["Reply is not an object with a nodes array"] };

  for (const n of raw.nodes) {
    if (!isRecord(n) || typeof n.id !== "string" || !n.id) {
      errors.push("Node without an id");
      continue;
    }
    if (typeof n.kind !== "string" || !(n.kind in NODE_KINDS)) {
      errors.push(`Unknown node kind "${String(n.kind)}"`);
      continue;
    }
    if (workflow.nodes.some((x) => x.id === n.id)) {
      errors.push(`Duplicate node id "${n.id}"`);
      continue;
    }
    const kind = n.kind as NodeKind;
    const config: Record<string, string> = {};
    for (const field of NODE_KINDS[kind].fields) {
      const value = isRecord(n.config) ? n.config[field.key] : undefined;
      if (plannable(field) && typeof value === "string") config[field.key] = value;
    }
    workflow.nodes.push({ id: n.id, kind, position: { x: 0, y: 0 }, config });
  }

  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (!isRecord(e) || typeof e.source !== "string" || typeof e.target !== "string") {
      errors.push("Edge without source and target");
      continue;
    }
    const error = connectionError(workflow, e.source, e.target);
    if (error) errors.push(`${e.source} -> ${e.target}: ${error}`);
    else workflow.edges.push({ id: `e-${e.source}-${e.target}`, source: e.source, target: e.target });
  }

  const complete = onCompletePath(workflow);
  for (const n of workflow.nodes) if (!complete.has(n.id)) errors.push(`${n.id} is not on a path from an input to an output`);
  const kept: Workflow = {
    nodes: workflow.nodes.filter((n) => complete.has(n.id)),
    edges: workflow.edges.filter((e) => complete.has(e.source) && complete.has(e.target)),
  };
  if (kept.nodes.length === 0) errors.push("No valid nodes");
  return { workflow: layout(kept), errors };
}

// Nodes reachable from a source kind that can also reach a sink kind; anything else would never run usefully.
function onCompletePath(workflow: Workflow): Set<string> {
  const walk = (start: (n: WorkflowNode) => boolean, next: (id: string) => string[]) => {
    const seen = new Set<string>();
    const stack = workflow.nodes.filter(start).map((n) => n.id);
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...next(id));
    }
    return seen;
  };
  const fromSource = walk(
    (n) => NODE_KINDS[n.kind].input === null,
    (id) => workflow.edges.filter((e) => e.source === id).map((e) => e.target),
  );
  const toSink = walk(
    (n) => NODE_KINDS[n.kind].output === null,
    (id) => workflow.edges.filter((e) => e.target === id).map((e) => e.source),
  );
  return new Set([...fromSource].filter((id) => toSink.has(id)));
}

// Column = longest path from a source, so every edge points rightwards.
export function layout(workflow: Workflow): Workflow {
  const column = new Map(workflow.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < workflow.nodes.length; pass++) {
    for (const e of workflow.edges) {
      const next = (column.get(e.source) ?? 0) + 1;
      if (next > (column.get(e.target) ?? 0)) column.set(e.target, next);
    }
  }
  const rows = new Map<number, number>();
  const nodes = workflow.nodes.map((n) => {
    const col = column.get(n.id)!;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    return { ...n, position: { x: col * COLUMN_WIDTH, y: row * ROW_HEIGHT } };
  });
  return { ...workflow, nodes };
}

type Step = { kind: NodeKind; config?: Record<string, string> };

function chain(steps: Step[]): Workflow {
  const nodes: WorkflowNode[] = steps.map((s, i) => ({
    id: `${s.kind}-${i + 1}`,
    kind: s.kind,
    position: { x: 0, y: 0 },
    config: s.config ?? {},
  }));
  const edges = nodes.slice(1).map((n, i) => ({ id: `e-${nodes[i].id}-${n.id}`, source: nodes[i].id, target: n.id }));
  return layout({ nodes, edges });
}

const SPOKEN = "\nReplies are spoken aloud, so answer in one to three short sentences with no markdown.";

// Checked in order; the first match wins. No match means a plain text chat.
const RULES: Array<{ test: RegExp; steps: (systemPrompt: string) => Step[] }> = [
  {
    test: /transcri|dictat|caption/,
    steps: () => [{ kind: "audioInput" }, { kind: "speechToText" }, { kind: "textOutput" }],
  },
  {
    test: /read\b.*\baloud|out loud|speak (the |this )?text|text to speech|narrat/,
    steps: () => [{ kind: "textInput", config: { text: "Hello from your workflow." } }, { kind: "textToSpeech" }, { kind: "audioOutput" }],
  },
  {
    test: /voice|speak|call|talk|phone/,
    steps: (systemPrompt) => [
      { kind: "audioInput" },
      { kind: "speechToText" },
      { kind: "llm", config: { systemPrompt: systemPrompt + SPOKEN } },
      { kind: "textToSpeech" },
      { kind: "audioOutput" },
    ],
  },
];

function matchRule(description: string) {
  const text = description.toLowerCase();
  return RULES.find((r) => r.test.test(text));
}

// Deterministic last resort when no model reply is usable.
export function planFromKeywords(description: string): Workflow {
  const systemPrompt = `You are an assistant for this use case: ${description.trim()}`;
  const rule = matchRule(description);
  if (rule) return chain(rule.steps(systemPrompt));
  return chain([{ kind: "textInput", config: { text: "Hello" } }, { kind: "llm", config: { systemPrompt } }, { kind: "textOutput" }]);
}

// When the description clearly names a modality, the model's plan must start and end with the same kinds.
export function intentError(description: string, workflow: Workflow): string | null {
  const rule = matchRule(description);
  if (!rule) return null;
  const steps = rule.steps("");
  const missing = [steps[0].kind, steps[steps.length - 1].kind].filter((k) => !workflow.nodes.some((n) => n.kind === k));
  return missing.length ? `The request needs ${missing.join(" and ")}` : null;
}

export type PlanSource = { kind: "model"; model: string } | { kind: "fallback"; reason: string };

export async function generateWorkflow(
  description: string,
  model: string | undefined,
  complete: (system: string, user: string) => Promise<string>,
): Promise<{ workflow: Workflow; source: PlanSource }> {
  if (!model) return { workflow: planFromKeywords(description), source: { kind: "fallback", reason: "No inference deployment" } };
  const system = plannerPrompt();
  let reason: string;
  try {
    const attempt = async (prompt: string) => {
      const plan = validatePlan(extractJson(await complete(system, prompt)));
      const found = plan.workflow.nodes.length > 0;
      const intent = found ? intentError(description, plan.workflow) : null;
      return { workflow: plan.workflow, errors: intent ? [...plan.errors, intent] : plan.errors, ok: found && !intent };
    };
    const first = await attempt(description);
    if (first.ok) return { workflow: first.workflow, source: { kind: "model", model } };
    const second = await attempt(
      `${description}\n\nYour previous reply was invalid: ${first.errors.join("; ")}. Reply with only the JSON object.`,
    );
    if (second.ok) return { workflow: second.workflow, source: { kind: "model", model } };
    reason = second.errors.join("; ");
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  return { workflow: planFromKeywords(description), source: { kind: "fallback", reason } };
}
