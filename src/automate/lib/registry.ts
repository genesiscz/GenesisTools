// src/automate/lib/registry.ts

import type { ExecutionContext, PresetStep, StepResult } from "./types";

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

/** Internal registry: action prefix -> handler */
const handlers = new Map<string, StepHandler>();

/**
 * Register a step handler for a given action prefix.
 *
 * @example
 *   registerStepHandler("http", httpHandler)   // matches http.get, http.post, ...
 *   registerStepHandler("parallel", handler)   // matches exactly "parallel"
 */
export function registerStepHandler(prefix: string, handler: StepHandler): void {
  handlers.set(prefix, handler);
}

/**
 * Resolve the handler for a given step action.
 * Tries exact match first, then prefix match (substring before first dot).
 */
export function resolveStepHandler(action: string): StepHandler | undefined {
  if (handlers.has(action)) return handlers.get(action);

  const dotIndex = action.indexOf(".");
  if (dotIndex > 0) {
    const prefix = action.substring(0, dotIndex);
    return handlers.get(prefix);
  }

  return undefined;
}

/** List all registered handler prefixes (for help/validation) */
export function getRegisteredActions(): string[] {
  return Array.from(handlers.keys()).sort();
}
