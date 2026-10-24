import { describe, expect, it, vi } from "vitest";
import { connectionError, runOrder, runWorkflow } from "../engine";
import { NODE_KINDS } from "../nodeKinds";
import { BANKING_SYSTEM_PROMPT, TEMPLATES, autofillModels } from "../templates";
import type { NodeKind, NodeRun, RunContext, Workflow } from "../types";

function wf(kinds: Record<string, NodeKind>, edges: Array<[string, string]> = []): Workflow {
  return {
    nodes: Object.entries(kinds).map(([id, kind]) => ({ id, kind, position: { x: 0, y: 0 }, config: {} })),
    edges: edges.map(([source, target]) => ({ id: `${source}-${target}`, source, target })),
  };
}

describe("node registry", () => {
  it("declares input and output port types per kind", () => {
    const ports = Object.fromEntries(
      Object.entries(NODE_KINDS).map(([kind, spec]) => [kind, [spec.input, spec.output]]),
    );
    expect(ports).toEqual({
      audioInput: [null, "audio"],
      textInput: [null, "text"],
      speechToText: ["audio", "text"],
      llm: ["text", "text"],
      textToSpeech: ["text", "audio"],
      textOutput: ["text", null],
      audioOutput: ["audio", null],
    });
  });
});

describe("connectionError", () => {
  const graph = wf({ mic: "audioInput", stt: "speechToText", llm: "llm", tts: "textToSpeech", out: "audioOutput", txt: "textInput" });

  it("allows matching port types", () => {
    expect(connectionError(graph, "mic", "stt")).toBeNull();
    expect(connectionError(graph, "stt", "llm")).toBeNull();
    expect(connectionError(graph, "tts", "out")).toBeNull();
  });

  it("rejects mismatched port types", () => {
    expect(connectionError(graph, "mic", "llm")).toBe("Cannot connect audio output to text input");
    expect(connectionError(graph, "llm", "out")).toBe("Cannot connect text output to audio input");
  });

  it("rejects nodes without the needed port and self loops", () => {
    expect(connectionError(graph, "out", "stt")).toBe("Audio output has no output");
    expect(connectionError(graph, "llm", "txt")).toBe("Text input has no input");
    expect(connectionError(graph, "llm", "llm")).toBe("A node cannot connect to itself");
  });

  it("rejects a second input and cycles", () => {
    const linked = wf({ a: "textInput", b: "llm", c: "llm", d: "textInput" }, [["a", "b"], ["b", "c"]]);
    expect(connectionError(linked, "d", "b")).toBe("LLM already has an input");
    const loop = wf({ b: "llm", c: "llm" }, [["b", "c"]]);
    expect(connectionError(loop, "c", "b")).toBe("Connection would create a cycle");
  });
});

describe("runOrder", () => {
  it("orders by edges, not by node array order", () => {
    const graph = wf({ out: "textOutput", llm: "llm", txt: "textInput" }, [["llm", "out"], ["txt", "llm"]]);
    expect(runOrder(graph)).toEqual(["txt", "llm", "out"]);
  });

  it("throws on cycles", () => {
    expect(() => runOrder(wf({ a: "llm", b: "llm" }, [["a", "b"], ["b", "a"]]))).toThrow("Workflow contains a cycle");
  });
});

describe("autofillModels", () => {
  it("picks STT and TTS deployments by name and LLM by model_type", () => {
    const dep = (modelName: string, model_type: string) => ({
      id: modelName, name: modelName, modelName, model_type, endpointUrl: "", status: "READY",
    });
    const filled = autofillModels(TEMPLATES.bankingVoice.build(), [
      dep("kokoro-tts", "audio_generation"),
      dep("whisper-small", "audio_generation"),
      dep("llama-3-8b", "inference"),
    ]);
    expect(filled.nodes.map((n) => n.config.model ?? null)).toEqual([null, "whisper-small", "llama-3-8b", "kokoro-tts", null]);
  });

  const audio = (modelName: string) => ({
    id: modelName, name: modelName, modelName, model_type: "audio_generation", endpointUrl: "", status: "READY",
  });

  it("does not give TTS an STT model whose name mentions speech", () => {
    const filled = autofillModels(TEMPLATES.bankingVoice.build(), [audio("Speech Recognition"), audio("Kokoro")]);
    expect(filled.nodes.map((n) => n.config.model ?? null)).toEqual([null, "Speech Recognition", null, "Kokoro", null]);
  });

  it("gives STT and TTS different deployments when no name matches", () => {
    const filled = autofillModels(TEMPLATES.bankingVoice.build(), [audio("model-a"), audio("model-b")]);
    expect(filled.nodes.map((n) => n.config.model ?? null)).toEqual([null, "model-a", null, "model-b", null]);
  });
});

describe("runWorkflow with the banking voice template", () => {
  it("calls STT, LLM and TTS in order and passes outputs node to node", async () => {
    const template = TEMPLATES.bankingVoice.build();
    const workflow: Workflow = {
      ...template,
      nodes: template.nodes.map((n) => ({
        ...n,
        config: { ...n.config, ...({ speechToText: { model: "whisper" }, llm: { model: "llama" }, textToSpeech: { model: "kokoro", voice: "af_bella" } } as Record<string, Record<string, string>>)[n.kind] },
      })),
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/audio/transcriptions")) return Response.json({ text: "What is my balance?" });
      if (url.endsWith("/v1/chat/completions"))
        return Response.json({ choices: [{ message: { content: "<think>lookup</think>Your balance is $1,204." } }] });
      return new Response("mp3-bytes", { headers: { "Content-Type": "audio/mpeg" } });
    });
    const mic = new Blob(["webm-bytes"], { type: "audio/webm" });
    const ctx: RunContext = {
      baseUrl: "http://inference.test/",
      token: "tok",
      fetch: fetchMock as unknown as typeof fetch,
      audioInputs: { "audioInput-1": mic },
    };

    const runs = await runWorkflow(workflow, ctx);

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "http://inference.test/v1/audio/transcriptions",
      "http://inference.test/v1/chat/completions",
      "http://inference.test/v1/audio/speech",
    ]);
    for (const [, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      const headers = new Headers(init.headers);
      expect(init.method).toBe("POST");
      expect(headers.get("Authorization")).toBe("Bearer tok");
      expect(headers.get("x-sandbox")).toBe("true");
    }

    const [sttInit, llmInit, ttsInit] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).map((c) => c[1]);
    const form = sttInit.body as FormData;
    expect(form.get("model")).toBe("whisper");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.webm");
    expect(await file.text()).toBe("webm-bytes");

    expect(JSON.parse(llmInit.body as string)).toEqual({
      model: "llama",
      messages: [
        { role: "system", content: BANKING_SYSTEM_PROMPT },
        { role: "user", content: "What is my balance?" },
      ],
    });
    expect(JSON.parse(ttsInit.body as string)).toEqual({ model: "kokoro", input: "Your balance is $1,204.", voice: "af_bella" });

    expect(Object.fromEntries(Object.entries(runs).map(([id, r]) => [id, r.status]))).toEqual({
      "audioInput-1": "done",
      "speechToText-2": "done",
      "llm-3": "done",
      "textToSpeech-4": "done",
      "audioOutput-5": "done",
    });
    expect(runs["speechToText-2"].output).toEqual({ type: "text", text: "What is my balance?" });
    expect(runs["llm-3"].output).toEqual({ type: "text", text: "Your balance is $1,204." });
    const out = runs["audioOutput-5"].output;
    expect(out?.type).toBe("audio");
    expect(out?.type === "audio" && (await out.blob.text())).toBe("mp3-bytes");
  });

  it("stops at the first failing node and reports the API detail", async () => {
    const workflow = TEMPLATES.textChat.build();
    workflow.nodes[1].config.model = "llama";
    const fetchMock = vi.fn(async () => Response.json({ detail: "Model not ready" }, { status: 503 }));
    const runs = await runWorkflow(workflow, {
      baseUrl: "http://x", token: null, fetch: fetchMock as unknown as typeof fetch, audioInputs: {},
    });
    expect(runs["textInput-1"].status).toBe("done");
    expect(runs["llm-2"]).toMatchObject({ status: "error", error: "Model not ready" });
    expect(runs["textOutput-3"].status).toBe("idle");
  });

  it("errors when the mic has no recording", async () => {
    const runs = await runWorkflow(TEMPLATES.bankingVoice.build(), {
      baseUrl: "http://x", token: null, fetch: vi.fn() as unknown as typeof fetch, audioInputs: {},
    });
    expect(runs["audioInput-1"]).toMatchObject({ status: "error", error: "Record or upload audio first" });
  });
});

describe("runWorkflow timing", () => {
  it("emits startedAt when a node starts and ms when it finishes", async () => {
    const workflow = TEMPLATES.textChat.build();
    workflow.nodes[1].config.model = "llama";
    const fetchMock = vi.fn(async () => Response.json({ choices: [{ message: { content: "hi" } }] }));
    const now = vi.spyOn(performance, "now");
    let clock = 1000;
    now.mockImplementation(() => (clock += 100));
    const events: Array<[string, NodeRun]> = [];
    try {
      await runWorkflow(
        workflow,
        { baseUrl: "http://x", token: null, fetch: fetchMock as unknown as typeof fetch, audioInputs: {} },
        (id, r) => events.push([id, r]),
      );
    } finally {
      now.mockRestore();
    }
    const llm = events.filter(([id, r]) => id === "llm-2" && r.status !== "idle").map(([, r]) => r);
    expect(llm.map((r) => [r.status, r.startedAt, r.ms])).toEqual([
      ["running", 1300, undefined],
      ["done", 1300, 100],
    ]);
  });
});
