import { beforeEach, describe, expect, it } from "vitest";
import { deleteWorkflow, loadHistory, loadSavedWorkflows, saveHistory, saveWorkflow } from "../storage";
import { TEMPLATES } from "../templates";

beforeEach(() => localStorage.clear());

describe("workflow storage", () => {
  it("round-trips and deletes saved workflows", () => {
    const workflow = TEMPLATES.textChat.build();
    expect(saveWorkflow("Chat", workflow)).toBe(true);
    expect(loadSavedWorkflows()).toEqual({ Chat: workflow });
    deleteWorkflow("Chat");
    expect(loadSavedWorkflows()).toEqual({});
  });

  it("returns an empty set for corrupt storage", () => {
    localStorage.setItem("inferia.workflows", "{not json");
    expect(loadSavedWorkflows()).toEqual({});
  });

  it("round-trips latency history and tolerates corrupt data", () => {
    saveHistory({ "llm-3": [1100, 1200] });
    expect(loadHistory()).toEqual({ "llm-3": [1100, 1200] });
    localStorage.setItem("inferia.workflow.latency", "nope");
    expect(loadHistory()).toEqual({});
  });
});
