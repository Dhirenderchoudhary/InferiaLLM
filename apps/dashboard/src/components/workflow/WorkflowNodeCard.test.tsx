import { act, fireEvent, render, screen } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasContext, type CanvasContextValue } from "./canvasContext";
import { WorkflowNodeCard, type FlowNode } from "./WorkflowNodeCard";

class FakeRecorder {
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  stream = { getTracks: () => [] };
  start() {}
  stop() {
    this.ondataavailable?.({ data: new Blob(["voice"]) });
    this.onstop?.();
  }
}

function canvas(setInput: CanvasContextValue["setInput"]): CanvasContextValue {
  return {
    deployments: [], runs: {}, history: {}, inputs: {},
    setConfig: () => {}, setInput, removeNode: () => {},
    readiness: {}, deploy: () => {},
  };
}

function card(value: CanvasContextValue) {
  const props = { id: "mic", data: { kind: "audioInput", config: {} }, selected: false } as unknown as NodeProps<FlowNode>;
  return (
    <ReactFlowProvider>
      <CanvasContext.Provider value={value}>
        <WorkflowNodeCard {...props} />
      </CanvasContext.Provider>
    </ReactFlowProvider>
  );
}

describe("AudioSource recording", () => {
  beforeEach(() => {
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("hands the recording to the current setInput, not the one from when Record was clicked", async () => {
    const atRecord = vi.fn();
    const current = vi.fn();
    const { rerender } = render(card(canvas(atRecord)));

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record" })));
    // A re-render while recording gives a new setInput (with the latest run state).
    rerender(card(canvas(current)));
    fireEvent.click(screen.getByRole("button", { name: "Stop and run" }));

    expect(current).toHaveBeenCalledWith("mic", expect.any(Blob));
    expect(atRecord).not.toHaveBeenCalled();
  });
});
