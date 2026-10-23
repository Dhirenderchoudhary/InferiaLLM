import { createContext, useContext } from "react";
import type { Deployment } from "@/hooks/useReadyDeployments";
import type { NodeRun } from "@/lib/workflow/types";

export interface CanvasContextValue {
  deployments: Deployment[];
  runs: Record<string, NodeRun>;
  audioInputs: Record<string, Blob>;
  setConfig: (nodeId: string, key: string, value: string) => void;
  setAudio: (nodeId: string, blob: Blob) => void;
  removeNode: (nodeId: string) => void;
}

export const CanvasContext = createContext<CanvasContextValue | null>(null);

export function useCanvas(): CanvasContextValue {
  const ctx = useContext(CanvasContext);
  if (!ctx) throw new Error("useCanvas must be used inside CanvasContext");
  return ctx;
}
