import { describe, expect, it, vi } from "vitest";
import { extractJson, generateWorkflow, intentError, layout, planFromKeywords, plannerPrompt, validatePlan } from "../generate";
import type { Workflow } from "../types";

const kinds = (w: Workflow) => w.nodes.map((n) => n.kind);
const pairs = (w: Workflow) => w.edges.map((e) => `${e.source}>${e.target}`);

describe("plannerPrompt", () => {
  it("lists every registry kind with its ports and plannable config", () => {
    const prompt = plannerPrompt();
    expect(prompt).toContain("- llm: Chat completion with a system prompt. Input: text. Output: text. Config: systemPrompt (system prompt).");
    expect(prompt).toContain("- audioInput: Record from the mic or upload a file. Input: none. Output: audio. Config: none.");
    expect(prompt).toContain("- textToSpeech: Synthesize speech with a TTS model. Input: text. Output: audio. Config: none.");
    expect(prompt).not.toContain("model (model)");
    expect(prompt).not.toContain("voice (voice)");
  });
});

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips code fences and surrounding prose", () => {
    expect(extractJson('Sure! Here it is:\n```json\n{"nodes":[{"id":"n1"}]}\n```\nEnjoy')).toEqual({ nodes: [{ id: "n1" }] });
  });

  it("takes only the first object and ignores braces inside strings", () => {
    expect(extractJson('{"text":"a } b {"} {"second":true}')).toEqual({ text: "a } b {" });
  });

  it("returns null for no object or broken JSON", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson('{"a": }')).toBeNull();
    expect(extractJson('{"a": 1')).toBeNull();
  });
});

describe("validatePlan", () => {
  it("keeps a valid chain, drops model config, and lays it out in columns", () => {
    const { workflow, errors } = validatePlan({
      nodes: [
        { id: "a", kind: "textInput", config: { text: "hi", bogus: "x" } },
        { id: "b", kind: "llm", config: { model: "gpt-9", systemPrompt: "Be brief" } },
        { id: "c", kind: "textOutput" },
      ],
      edges: [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    });
    expect(errors).toEqual([]);
    expect(workflow).toEqual({
      nodes: [
        { id: "a", kind: "textInput", position: { x: 0, y: 0 }, config: { text: "hi" } },
        { id: "b", kind: "llm", position: { x: 280, y: 0 }, config: { systemPrompt: "Be brief" } },
        { id: "c", kind: "textOutput", position: { x: 560, y: 0 }, config: {} },
      ],
      edges: [
        { id: "e-a-b", source: "a", target: "b" },
        { id: "e-b-c", source: "b", target: "c" },
      ],
    });
  });

  it("drops unknown kinds, duplicates and edges that fail connectionError", () => {
    const { workflow, errors } = validatePlan({
      nodes: [
        { id: "a", kind: "audioInput" },
        { id: "b", kind: "hologram" },
        { id: "c", kind: "textOutput" },
        { id: "c", kind: "llm" },
        { id: "d", kind: "speechToText" },
      ],
      edges: [
        { source: "a", target: "c" },
        { source: "a", target: "b" },
        { source: "a", target: "d" },
        { source: "d", target: "c" },
        { source: "a", target: "d" },
      ],
    });
    expect(kinds(workflow)).toEqual(["audioInput", "textOutput", "speechToText"]);
    expect(pairs(workflow)).toEqual(["a>d", "d>c"]);
    expect(errors).toEqual([
      'Unknown node kind "hologram"',
      'Duplicate node id "c"',
      "a -> c: Cannot connect audio output to text input",
      "a -> b: Unknown node",
      "a -> d: Speech to text already has an input",
    ]);
  });

  it("reports when nothing usable remains", () => {
    expect(validatePlan(null).errors).toEqual(["Reply is not an object with a nodes array"]);
    expect(validatePlan({ nodes: [{ id: "x", kind: "nope" }] }).errors).toEqual(['Unknown node kind "nope"', "No valid nodes"]);
    expect(validatePlan({ nodes: [{ id: "a", kind: "textInput" }, { id: "b", kind: "textOutput" }], edges: [] }).errors).toEqual([
      "a is not on a path from an input to an output",
      "b is not on a path from an input to an output",
      "No valid nodes",
    ]);
  });

  it("drops nodes off the input-to-output path and deployment-specific config", () => {
    // Shape of a real small-model reply: a chain with no sink plus stray nodes.
    const { workflow, errors } = validatePlan({
      nodes: [
        { id: "t", kind: "textInput", config: { text: "Hi" } },
        { id: "l", kind: "llm" },
        { id: "v", kind: "textToSpeech", config: { voice: "en-US-ElizabethVoice" } },
        { id: "s", kind: "speechToText" },
        { id: "o", kind: "textOutput" },
        { id: "p", kind: "audioOutput" },
      ],
      edges: [
        { source: "t", target: "l" },
        { source: "l", target: "v" },
        { source: "v", target: "p" },
      ],
    });
    expect(kinds(workflow)).toEqual(["textInput", "llm", "textToSpeech", "audioOutput"]);
    expect(workflow.nodes[2].config).toEqual({});
    expect(errors).toEqual(["s is not on a path from an input to an output", "o is not on a path from an input to an output"]);
  });
});

describe("layout", () => {
  it("places nodes by longest path depth and stacks shared columns", () => {
    const wf: Workflow = {
      nodes: ["t", "l", "o", "s", "a"].map((id) => ({
        id,
        kind: "textInput",
        position: { x: 9, y: 9 },
        config: {},
      })),
      edges: [
        { id: "1", source: "l", target: "o" },
        { id: "2", source: "t", target: "l" },
        { id: "3", source: "t", target: "s" },
        { id: "4", source: "s", target: "a" },
      ],
    };
    expect(Object.fromEntries(layout(wf).nodes.map((n) => [n.id, n.position]))).toEqual({
      t: { x: 0, y: 0 },
      l: { x: 280, y: 0 },
      o: { x: 560, y: 0 },
      s: { x: 280, y: 320 },
      a: { x: 560, y: 320 },
    });
  });
});

describe("planFromKeywords", () => {
  it("builds a voice pipeline for voice requests", () => {
    const wf = planFromKeywords("A voice assistant that answers banking questions and talks back");
    expect(kinds(wf)).toEqual(["audioInput", "speechToText", "llm", "textToSpeech", "audioOutput"]);
    expect(pairs(wf)).toEqual([
      "audioInput-1>speechToText-2",
      "speechToText-2>llm-3",
      "llm-3>textToSpeech-4",
      "textToSpeech-4>audioOutput-5",
    ]);
    expect(wf.nodes.map((n) => n.position.x)).toEqual([0, 280, 560, 840, 1120]);
    expect(wf.nodes[2].config.systemPrompt).toBe(
      "You are an assistant for this use case: A voice assistant that answers banking questions and talks back\nReplies are spoken aloud, so answer in one to three short sentences with no markdown.",
    );
  });

  it("transcribes", () => {
    expect(kinds(planFromKeywords("Transcribe my meeting recordings"))).toEqual(["audioInput", "speechToText", "textOutput"]);
  });

  it("reads text aloud", () => {
    expect(kinds(planFromKeywords("Read aloud a paragraph I paste"))).toEqual(["textInput", "textToSpeech", "audioOutput"]);
    expect(kinds(planFromKeywords("speak text for me"))).toEqual(["textInput", "textToSpeech", "audioOutput"]);
  });

  it("defaults to a text chat", () => {
    const wf = planFromKeywords("Summarize support tickets");
    expect(kinds(wf)).toEqual(["textInput", "llm", "textOutput"]);
    expect(wf.nodes[0].config).toEqual({ text: "Hello" });
  });
});

describe("intentError", () => {
  const plan = (k: string[]) => validatePlan({ nodes: k.map((kind, i) => ({ id: `n${i}`, kind })), edges: k.slice(1).map((_, i) => ({ source: `n${i}`, target: `n${i + 1}` })) }).workflow;

  it("requires the modality the description names", () => {
    expect(intentError("a voice bot that talks back", plan(["textInput", "textOutput"]))).toBe("The request needs audioInput and audioOutput");
    expect(intentError("transcribe calls", plan(["audioInput", "speechToText", "textOutput"]))).toBeNull();
    expect(intentError("read my notes aloud", plan(["textInput", "llm", "textOutput"]))).toBe("The request needs audioOutput");
  });

  it("accepts anything for descriptions without a keyword", () => {
    expect(intentError("summarize tickets", plan(["audioInput", "speechToText", "textOutput"]))).toBeNull();
  });
});

describe("generateWorkflow", () => {
  const good = '{"nodes":[{"id":"i","kind":"textInput","config":{"text":"q"}},{"id":"o","kind":"textOutput"}],"edges":[{"source":"i","target":"o"}]}';

  it("uses the model reply when valid", async () => {
    const complete = vi.fn().mockResolvedValue("```json\n" + good + "\n```");
    const result = await generateWorkflow("echo text", "bank-llm", complete);
    expect(result.source).toEqual({ kind: "model", model: "bank-llm" });
    expect(kinds(result.workflow)).toEqual(["textInput", "textOutput"]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("retries once with the validation errors", async () => {
    const complete = vi.fn().mockResolvedValueOnce('{"nodes":[{"id":"x","kind":"video"}]}').mockResolvedValueOnce(good);
    const result = await generateWorkflow("echo text", "bank-llm", complete);
    expect(result.source).toEqual({ kind: "model", model: "bank-llm" });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][1]).toBe(
      'echo text\n\nYour previous reply was invalid: Unknown node kind "video"; No valid nodes. Reply with only the JSON object.',
    );
  });

  it("rejects a valid plan that ignores the requested modality", async () => {
    const complete = vi.fn().mockResolvedValue(good);
    const result = await generateWorkflow("a voice assistant", "bank-llm", complete);
    expect(result.source).toEqual({ kind: "fallback", reason: "The request needs audioInput and audioOutput" });
    expect(complete.mock.calls[1][1]).toBe(
      "a voice assistant\n\nYour previous reply was invalid: The request needs audioInput and audioOutput. Reply with only the JSON object.",
    );
    expect(kinds(result.workflow)).toEqual(["audioInput", "speechToText", "llm", "textToSpeech", "audioOutput"]);
  });

  it("falls back to the keyword planner after two bad replies", async () => {
    const complete = vi.fn().mockResolvedValue("I cannot help with that");
    const result = await generateWorkflow("transcribe calls", "bank-llm", complete);
    expect(result.source).toEqual({ kind: "fallback", reason: "Reply is not an object with a nodes array" });
    expect(kinds(result.workflow)).toEqual(["audioInput", "speechToText", "textOutput"]);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("falls back when the model call fails or no model exists", async () => {
    const failed = await generateWorkflow("chat", "bank-llm", vi.fn().mockRejectedValue(new Error("API Error: 502")));
    expect(failed.source).toEqual({ kind: "fallback", reason: "API Error: 502" });
    const none = await generateWorkflow("chat", undefined, vi.fn());
    expect(none.source).toEqual({ kind: "fallback", reason: "No inference deployment" });
  });
});
