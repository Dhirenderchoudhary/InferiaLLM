import { useCallback, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { computeApi } from "@/lib/api";
import { deployRequests, type CatalogModel, type PendingDeploy } from "@/lib/workflow/readiness";
import { listPools } from "@/services/poolService";

interface PreflightResponse {
  ready: boolean;
  checks: Array<{ passed: boolean; message?: string | null; check: string }>;
}

function errorMessage(err: unknown): string {
  const body = (err as { response?: { data?: { detail?: unknown; message?: unknown } } }).response?.data;
  const detail = body?.detail ?? body?.message;
  if (typeof detail === "string") return detail;
  return err instanceof Error ? err.message : "Request failed";
}

// Preflight, then deploy on the first usable pool, the same requests NewDeployment sends for a pool deploy.
export function useNodeDeploys() {
  const { user, organizations } = useAuth();
  const [pending, setPending] = useState<Record<string, PendingDeploy>>({});

  const set = useCallback((nodeId: string, p: PendingDeploy | null) => {
    setPending((prev) => {
      const next = { ...prev };
      if (p) next[nodeId] = p;
      else delete next[nodeId];
      return next;
    });
  }, []);

  const deploy = async (nodeId: string, entry: CatalogModel) => {
    const orgId = user?.org_id || organizations?.[0]?.id;
    if (!orgId) return set(nodeId, { status: "waiting", reason: "organization context missing" });
    set(nodeId, { status: "deploying", deploymentName: entry.deploymentName });
    try {
      const pool = (await listPools(orgId)).find((p) => p.is_active && p.lifecycle_state !== "terminated");
      if (!pool) return set(nodeId, { status: "waiting", reason: "no active compute pool" });
      const req = deployRequests(entry, pool.pool_id, { orgId, ownerId: user?.user_id });
      const { data } = await computeApi.post<PreflightResponse>("/deployment/preflight", req.preflight);
      if (!data.ready) {
        const failed = data.checks.filter((c) => !c.passed).map((c) => c.message || c.check);
        return set(nodeId, { status: "waiting", reason: failed.join("; ") || "preflight failed" });
      }
      await computeApi.post("/deployment/deploy", req.deploy);
    } catch (err) {
      set(nodeId, { status: "waiting", reason: errorMessage(err) });
    }
  };

  const clear = useCallback((nodeId: string) => set(nodeId, null), [set]);
  const reset = useCallback(() => setPending({}), []);
  return { pending, deploy, clear, reset };
}
