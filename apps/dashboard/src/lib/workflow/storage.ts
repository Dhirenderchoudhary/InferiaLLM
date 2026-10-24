import type { History } from "./stats";
import type { Workflow } from "./types";

const KEY = "inferia.workflows";

export function loadSavedWorkflows(): Record<string, Workflow> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Workflow>) : {};
  } catch {
    return {};
  }
}

function write(all: Record<string, Workflow>): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export function saveWorkflow(name: string, workflow: Workflow): boolean {
  return write({ ...loadSavedWorkflows(), [name]: workflow });
}

export function deleteWorkflow(name: string): boolean {
  const all = loadSavedWorkflows();
  delete all[name];
  return write(all);
}

const HISTORY_KEY = "inferia.workflow.latency";

export function loadHistory(): History {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as History) : {};
  } catch {
    return {};
  }
}

export function saveHistory(history: History): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Latency history is a convenience; losing it is fine.
  }
}
