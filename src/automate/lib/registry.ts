// src/automate/lib/registry.ts

import type { PresetStep, StepResult } from "./types";

/**
 * Context passed to each step handler during execution.
 * Wraps ExecutionContext with convenience helpers for expression evaluation.
 */
export interface StepContext {
  /** Results of all previously executed steps, keyed by step ID */
  steps: Record<string, StepResult>;
  /** Global preset variables (resolved) */
  variables: Record<string, unknown>;
  /** Environment variables */
  env: Record<string, string>;
  /** Evaluate a single expression string against the current context */
  evaluate: (expr: string) => unknown;
  /** Resolve all {{ }} placeholders in a template string */
  interpolate: (template: string) => string;
  /** Structured logger */
  log: (level: "info" | "warn" | "error" | "debug", message: string) => void;
}

/** A step handler executes a step definition and returns a result */
export type StepHandler = (
  step: PresetStep,
  ctx: StepContext,
) => Promise<StepResult>;

export interface StepActionInfo {
  action: string;
  description: string;
  params: Array<{ name: string; required?: boolean; description: string }>;
  example?: Record<string, unknown>;
}

export interface StepCatalogEntry {
  prefix: string;
  description: string;
  actions: StepActionInfo[];
}

const handlers = new Map<string, StepHandler>();
const catalog = new Map<string, StepCatalogEntry>();

export function registerStepHandler(prefix: string, handler: StepHandler): void {
  handlers.set(prefix, handler);
}

export function registerStepCatalog(entry: StepCatalogEntry): void {
  catalog.set(entry.prefix, entry);
}

export function resolveStepHandler(action: string): StepHandler | undefined {
  if (handlers.has(action)) return handlers.get(action);

  const dotIndex = action.indexOf(".");
  if (dotIndex > 0) {
    const prefix = action.substring(0, dotIndex);
    return handlers.get(prefix);
  }

  return undefined;
}

export function getRegisteredActions(): string[] {
  return Array.from(handlers.keys()).sort();
}

export function getStepCatalog(): StepCatalogEntry[] {
  return Array.from(catalog.values()).sort((a, b) => a.prefix.localeCompare(b.prefix));
}
