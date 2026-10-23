import { describe, expect, it } from "vitest";
import type { Deployment } from "@/hooks/useReadyDeployments";
import { MODEL_CATALOG, deployRequests, nodeReadiness, runBlocker } from "../readiness";
import type { Workflow } from "../types";

function dep(modelName: string, model_type: string): Deployment {
  return { id: modelName, name: modelName, modelName, model_type, endpointUrl: "", status: "READY" };
}

const stt = { kind: "speechToText" as const, config: {} };
const whisperCatalog = MODEL_CATALOG.speechToText!;

describe("nodeReadiness", () => {
  it("treats nodes without a model field, or with a model set, as ready", () => {
    expect(nodeReadiness({ kind: "textInput", config: {} }, [], undefined)).toEqual({ state: "ready" });
    expect(nodeReadiness({ kind: "llm", config: { model: "bank-llm" } }, [], undefined)).toEqual({ state: "ready" });
  });

  it("asks to select a model when a matching deployment exists", () => {
    expect(nodeReadiness(stt, [dep("whisper-stt", "audio_generation")])).toEqual({ state: "selectModel" });
    expect(nodeReadiness({ kind: "llm", config: {} }, [dep("bank-llm", "inference")])).toEqual({ state: "selectModel" });
  });

  it("needs deployment when only non-matching deployments exist", () => {
    expect(nodeReadiness(stt, [dep("kokoro-tts", "audio_generation"), dep("bank-llm", "inference")])).toEqual({
      state: "needsDeployment",
      recommended: whisperCatalog,
    });
    expect(nodeReadiness({ kind: "textToSpeech", config: {} }, [])).toEqual({
      state: "needsDeployment",
      recommended: MODEL_CATALOG.textToSpeech,
    });
  });

  it("follows the pending deploy through deploying, waiting and deployed", () => {
    expect(nodeReadiness(stt, [], { status: "deploying", deploymentName: "whisper-tiny-stt" })).toEqual({
      state: "deploying",
      recommended: whisperCatalog,
    });
    expect(nodeReadiness(stt, [], { status: "waiting", reason: "no active compute pool" })).toEqual({
      state: "waiting",
      recommended: whisperCatalog,
      reason: "no active compute pool",
    });
    expect(
      nodeReadiness(stt, [dep("whisper-tiny-stt", "audio_generation")], { status: "deploying", deploymentName: "whisper-tiny-stt" }),
    ).toEqual({ state: "deployed", model: "whisper-tiny-stt" });
  });
});

describe("runBlocker", () => {
  const wf = (configs: Array<Record<string, string>>): Workflow => ({
    nodes: [
      { id: "a", kind: "audioInput", position: { x: 0, y: 0 }, config: {} },
      { id: "s", kind: "speechToText", position: { x: 0, y: 0 }, config: configs[0] },
      { id: "l", kind: "llm", position: { x: 0, y: 0 }, config: configs[1] },
    ],
    edges: [],
  });

  it("is null when every node is ready", () => {
    expect(runBlocker(wf([{ model: "w" }, { model: "l" }]), [], {})).toBeNull();
  });

  it("names the first blocked node and its reason", () => {
    expect(runBlocker(wf([{}, { model: "l" }]), [], {})).toBe("Speech to text: Needs deployment");
    expect(runBlocker(wf([{}, { model: "l" }]), [], { s: { status: "waiting", reason: "no active compute pool" } })).toBe(
      "Speech to text: Waiting for compute: no active compute pool",
    );
    expect(runBlocker(wf([{ model: "w" }, {}]), [], { l: { status: "deploying", deploymentName: "qwen2-5-1-5b" } })).toBe(
      "LLM: Deploying qwen2-5-1-5b",
    );
    expect(runBlocker(wf([{ model: "w" }, {}]), [dep("bank-llm", "inference")], {})).toBe("LLM: Select a model");
  });
});

describe("deployRequests", () => {
  it("builds the preflight and pool deploy payloads", () => {
    const req = deployRequests(MODEL_CATALOG.llm!, "pool-1", { orgId: "org-1", ownerId: "user-1" });
    expect(req.preflight).toEqual({
      model_id: "qwen2.5:1.5b",
      engine: "ollama",
      gpu_per_replica: 1,
      pool_id: "pool-1",
      model_type: "inference",
    });
    expect(req.deploy).toMatchObject({
      model_name: "qwen2-5-1-5b",
      model_version: "latest",
      replicas: 1,
      gpu_per_replica: 1,
      workload_type: "inference",
      pool_id: "pool-1",
      engine: "ollama",
      model_type: "inference",
      inference_model: "qwen2.5:1.5b",
      owner_id: "user-1",
      org_id: "org-1",
    });
    expect(deployRequests(whisperCatalog, "p", { orgId: "o" }).deploy.gpu_per_replica).toBe(0);
  });
});
