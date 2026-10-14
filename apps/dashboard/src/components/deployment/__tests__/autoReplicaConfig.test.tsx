import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { AutoReplicaConfig } from "../configSections";

function renderConfig(provider: string, autoReplicaEnabled = true) {
  const state = {
    autoReplicaEnabled,
    tokensPerSecondThreshold: "10",
    selectedPool: { provider },
  };
  return render(<AutoReplicaConfig state={state as never} dispatch={vi.fn()} />);
}

describe("the create form describes the autoscaler the pool actually has", () => {
  it("a kubernetes pool is told about replicas, not nodes", () => {
    renderConfig("k8s");
    expect(screen.getByText(/scale replicas automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/in-flight requests per replica/i)).toBeInTheDocument();
    expect(screen.queryByText(/provision new nodes/i)).not.toBeInTheDocument();
  });

  it("a kubernetes pool gets no tokens/sec field, which does nothing there", () => {
    renderConfig("k8s");
    expect(screen.queryByLabelText(/tokens\/sec threshold/i)).not.toBeInTheDocument();
  });

  it("any other pool keeps the node-provisioning text and the tokens/sec field", () => {
    renderConfig("aws");
    expect(screen.getByText(/provision new nodes/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tokens\/sec threshold/i)).toBeInTheDocument();
    expect(screen.queryByText(/in-flight requests per replica/i)).not.toBeInTheDocument();
  });

  it("nothing beyond the toggle shows while auto-replica is off", () => {
    renderConfig("k8s", false);
    expect(screen.queryByText(/in-flight requests per replica/i)).not.toBeInTheDocument();
  });
});
