import { useCallback, useRef, useState, type DragEvent } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type IsValidConnection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Loader2, Play, Save, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme-provider";
import { CanvasContext, type CanvasContextValue } from "@/components/workflow/canvasContext";
import { RunSummary } from "@/components/workflow/RunSummary";
import { WorkflowNodeCard, type FlowNode } from "@/components/workflow/WorkflowNodeCard";
import { useReadyDeployments, type Deployment } from "@/hooks/useReadyDeployments";
import { INFERENCE_URL } from "@/lib/api";
import { getToken } from "@/lib/tokenStore";
import { connectionError, runWorkflow } from "@/lib/workflow/engine";
import { NODE_KINDS } from "@/lib/workflow/nodeKinds";
import { recordRuns } from "@/lib/workflow/stats";
import { deleteWorkflow, loadHistory, loadSavedWorkflows, saveHistory, saveWorkflow } from "@/lib/workflow/storage";
import { TEMPLATES, autofillModels } from "@/lib/workflow/templates";
import type { NodeKind, NodeRun, Workflow } from "@/lib/workflow/types";

const nodeTypes = { step: WorkflowNodeCard };
const DRAG_TYPE = "application/x-workflow-node";

function toFlow(workflow: Workflow): { nodes: FlowNode[]; edges: Edge[] } {
  return {
    nodes: workflow.nodes.map((n) => ({
      id: n.id,
      type: "step",
      position: n.position,
      data: { kind: n.kind, config: n.config },
    })),
    edges: workflow.edges.map((e) => ({ ...e })),
  };
}

function fromFlow(nodes: FlowNode[], edges: Edge[]): Workflow {
  return {
    nodes: nodes.map((n) => ({ id: n.id, kind: n.data.kind, position: n.position, config: n.data.config })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  };
}

export default function Workflows() {
  const { data: deployments = [], isLoading } = useReadyDeployments();
  return (
    <div className="flex h-[calc(100dvh-7rem)] min-h-[560px] flex-col gap-4">
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">Workflows</h1>
        <p className="text-sm text-muted-foreground">Chain deployed models into a pipeline and run it end to end</p>
      </div>
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center rounded-xl border bg-card">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <ReactFlowProvider>
          <Canvas deployments={deployments} />
        </ReactFlowProvider>
      )}
    </div>
  );
}

function Canvas({ deployments }: { deployments: Deployment[] }) {
  const { theme } = useTheme();
  const { screenToFlowPosition, deleteElements, fitView } = useReactFlow<FlowNode>();
  const [initial] = useState(() => toFlow(autofillModels(TEMPLATES.bankingVoice.build(), deployments)));
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [runs, setRuns] = useState<Record<string, NodeRun>>({});
  const [history, setHistory] = useState(loadHistory);
  const [timing, setTiming] = useState<{ startedAt: number; endedAt: number | null } | null>(null);
  const [audioInputs, setAudioInputs] = useState<Record<string, Blob>>({});
  const [running, setRunning] = useState(false);
  const [saved, setSaved] = useState(loadSavedWorkflows);
  const [name, setName] = useState("");
  const counter = useRef(0);

  const loadWorkflow = useCallback(
    (workflow: Workflow) => {
      const flow = toFlow(workflow);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setRuns({});
      setAudioInputs({});
      setTiming(null);
      setHistory({});
      saveHistory({});
      requestAnimationFrame(() => fitView({ padding: 0.2 }));
    },
    [setNodes, setEdges, fitView],
  );

  const run = async (inputs = audioInputs) => {
    if (running) return;
    setRunning(true);
    const startedAt = performance.now();
    setTiming({ startedAt, endedAt: null });
    try {
      const results = await runWorkflow(
        fromFlow(nodes, edges),
        { baseUrl: INFERENCE_URL, token: getToken(), fetch: window.fetch.bind(window), audioInputs: inputs },
        (id, r) => setRuns((prev) => ({ ...prev, [id]: r })),
      );
      setTiming({ startedAt, endedAt: performance.now() });
      setHistory((prev) => {
        const next = recordRuns(prev, results);
        saveHistory(next);
        return next;
      });
      const failed = Object.values(results).find((r) => r.status === "error");
      if (failed) toast.error(failed.error);
    } catch (err) {
      setTiming(null);
      toast.error(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  };

  const addNode = (kind: NodeKind, position?: { x: number; y: number }) => {
    counter.current += 1;
    const node: FlowNode = {
      id: `${kind}-${Date.now()}-${counter.current}`,
      type: "step",
      position: position ?? { x: 40 * (counter.current % 8), y: 260 + 40 * (counter.current % 8) },
      data: { kind, config: {} },
    };
    setNodes((prev) => [...prev, node]);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData(DRAG_TYPE) as NodeKind;
    if (kind in NODE_KINDS) addNode(kind, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  const isValidConnection: IsValidConnection = (c) =>
    connectionError(fromFlow(nodes, edges), c.source, c.target) === null;

  const onConnect = (c: Connection) => setEdges((prev) => addEdge(c, prev));

  const ctx: CanvasContextValue = {
    deployments,
    runs,
    history,
    audioInputs,
    setConfig: (nodeId, key, value) =>
      setNodes((prev) =>
        prev.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, config: { ...n.data.config, [key]: value } } } : n)),
      ),
    setAudio: (nodeId, blob) => {
      const next = { ...audioInputs, [nodeId]: blob };
      setAudioInputs(next);
      void run(next);
    },
    removeNode: (nodeId) => void deleteElements({ nodes: [{ id: nodeId }] }),
  };

  const onSave = () => {
    const key = name.trim();
    if (!key) return toast.error("Name the workflow first");
    if (!saveWorkflow(key, fromFlow(nodes, edges))) return toast.error("Could not save to local storage");
    setSaved(loadSavedWorkflows());
    toast.success(`Saved "${key}"`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 overflow-y-auto rounded-xl border bg-card p-3 shadow-sm lg:w-60">
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase text-muted-foreground">Templates</h3>
          {Object.entries(TEMPLATES).map(([key, t]) => (
            <Button
              key={key}
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => loadWorkflow(autofillModels(t.build(), deployments))}
            >
              {t.label}
            </Button>
          ))}
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase text-muted-foreground">Nodes</h3>
          <p className="text-[11px] text-muted-foreground">Drag onto the canvas or click to add</p>
          {(Object.keys(NODE_KINDS) as NodeKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, kind);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => addNode(kind)}
              className="w-full cursor-grab rounded-lg border bg-background px-3 py-2 text-left hover:border-ember-500"
            >
              <div className="text-sm font-medium">{NODE_KINDS[kind].label}</div>
              <div className="text-[11px] text-muted-foreground">{NODE_KINDS[kind].description}</div>
            </button>
          ))}
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase text-muted-foreground">Saved</h3>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Workflow name"
              className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ember-500"
            />
            <Button size="sm" variant="outline" className="h-8 px-2" onClick={onSave} aria-label="Save workflow">
              <Save className="h-3.5 w-3.5" />
            </Button>
          </div>
          {Object.keys(saved).length === 0 && <p className="text-[11px] text-muted-foreground">Nothing saved yet</p>}
          {Object.entries(saved).map(([key, workflow]) => (
            <div key={key} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setName(key);
                  loadWorkflow(workflow);
                }}
                className="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-xs hover:bg-muted"
              >
                {key}
              </button>
              <button
                type="button"
                aria-label={`Delete ${key}`}
                onClick={() => {
                  deleteWorkflow(key);
                  setSaved(loadSavedWorkflows());
                }}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-500"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </section>
      </aside>

      <div className="relative min-h-[420px] flex-1 overflow-hidden rounded-xl border bg-card shadow-sm" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <div className="absolute right-3 top-3 z-10 flex items-start gap-2">
          {timing && <RunSummary workflow={fromFlow(nodes, edges)} runs={runs} {...timing} />}
          <Button variant="outline" size="sm" onClick={() => loadWorkflow({ nodes: [], edges: [] })}>
            Clear
          </Button>
          <Button size="sm" onClick={() => void run()} disabled={running || nodes.length === 0}>
            {running ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
            Run
          </Button>
        </div>
        {nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center text-sm text-muted-foreground">
            <WorkflowIcon className="mb-2 h-10 w-10 opacity-30" />
            Load a template or add nodes from the palette
          </div>
        )}
        <CanvasContext.Provider value={ctx}>
          <ReactFlow
            nodes={nodes}
            edges={edges.map((e) => ({ ...e, animated: running }))}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            defaultEdgeOptions={{ type: "smoothstep" }}
            colorMode={theme}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </CanvasContext.Provider>
      </div>
    </div>
  );
}
