import { useQuery } from "@tanstack/react-query";
import { computeApi } from "@/lib/api";

export interface Deployment {
  id: string;
  name: string;
  modelName: string;
  model_type: string;
  engine?: string;
  workload_type?: string;
  endpointUrl: string;
  status: string;
}

interface DeploymentResponse {
  deployments: Array<{
    deployment_id: string;
    model_name?: string;
    engine?: string;
    endpoint?: string;
    state?: string;
    model_type?: string;
    configuration?: {
      workload_type?: string;
    };
  }>;
}

// Pass a refetch interval to poll while a deployment is coming up.
export function useReadyDeployments(refetchInterval: number | false = false) {
  return useQuery<Deployment[]>({
    queryKey: ["sandbox-deployments"],
    queryFn: async () => {
      const res = await computeApi.get<DeploymentResponse>("/deployment/deployments");
      return (res.data.deployments || [])
        .filter((d) => d.state === "READY" || d.state === "RUNNING")
        .map((d) => ({
          id: d.deployment_id,
          name: d.model_name || `Deployment-${(d.deployment_id || "").slice(0, 8)}`,
          modelName: d.model_name || "-",
          model_type: d.model_type || "inference",
          engine: d.engine,
          workload_type: d.configuration?.workload_type,
          endpointUrl: d.endpoint || "",
          status: d.state || "UNKNOWN",
        }));
    },
    staleTime: 30000,
    refetchInterval,
  });
}
