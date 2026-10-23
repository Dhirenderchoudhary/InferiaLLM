import { NODE_KINDS } from "./nodeKinds";
import type { NodeRun, Payload, RunContext, Workflow } from "./types";

export function connectionError(workflow: Workflow, source: string, target: string): string | null {
  if (source === target) return "A node cannot connect to itself";
  const from = workflow.nodes.find((n) => n.id === source);
  const to = workflow.nodes.find((n) => n.id === target);
  if (!from || !to) return "Unknown node";
  const out = NODE_KINDS[from.kind].output;
  const inp = NODE_KINDS[to.kind].input;
  if (!out) return `${NODE_KINDS[from.kind].label} has no output`;
  if (!inp) return `${NODE_KINDS[to.kind].label} has no input`;
  if (out !== inp) return `Cannot connect ${out} output to ${inp} input`;
  if (workflow.edges.some((e) => e.target === target)) return `${NODE_KINDS[to.kind].label} already has an input`;
  if (reachable(workflow, target, source)) return "Connection would create a cycle";
  return null;
}

function reachable(workflow: Workflow, from: string, to: string): boolean {
  const stack = [from];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of workflow.edges) if (e.source === id) stack.push(e.target);
  }
  return false;
}

export function runOrder(workflow: Workflow): string[] {
  const indegree = new Map(workflow.nodes.map((n) => [n.id, 0]));
  for (const e of workflow.edges) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  const ready = workflow.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const e of workflow.edges) {
      if (e.source !== id) continue;
      const left = indegree.get(e.target)! - 1;
      indegree.set(e.target, left);
      if (left === 0) ready.push(e.target);
    }
  }
  if (order.length !== workflow.nodes.length) throw new Error("Workflow contains a cycle");
  return order;
}

export async function runWorkflow(
  workflow: Workflow,
  ctx: RunContext,
  onUpdate: (nodeId: string, run: NodeRun) => void = () => {},
): Promise<Record<string, NodeRun>> {
  const order = runOrder(workflow);
  const runs: Record<string, NodeRun> = {};
  const outputs = new Map<string, Payload>();
  const update = (id: string, run: NodeRun) => {
    runs[id] = run;
    onUpdate(id, run);
  };
  for (const id of order) update(id, { status: "idle" });

  for (const id of order) {
    const node = workflow.nodes.find((n) => n.id === id)!;
    const spec = NODE_KINDS[node.kind];
    // Upstream nodes have already finished here, so this measures only this node's own work.
    const startedAt = performance.now();
    update(id, { status: "running", startedAt });
    try {
      let input: Payload | null = null;
      if (spec.input) {
        const edge = workflow.edges.find((e) => e.target === id);
        if (!edge) throw new Error("Input is not connected");
        input = outputs.get(edge.source)!;
      }
      const output = await spec.run(input, node, ctx);
      outputs.set(id, output);
      update(id, { status: "done", startedAt, ms: Math.round(performance.now() - startedAt), output });
    } catch (err) {
      update(id, {
        status: "error",
        startedAt,
        ms: Math.round(performance.now() - startedAt),
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }
  return runs;
}
