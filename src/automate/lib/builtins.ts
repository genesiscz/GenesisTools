// src/automate/lib/builtins.ts

import * as p from "@clack/prompts";
import type { ExecutionContext, PresetStep, StepResult } from "./types.ts";
import { resolveExpression, resolveParams } from "./expressions.ts";

/** The set of built-in action names that are handled directly (not via Bun.spawn) */
export const BUILTIN_ACTIONS = new Set(["if", "log", "prompt", "shell", "set"]);

/** Check if an action name is a built-in */
export function isBuiltinAction(action: string): boolean {
  return BUILTIN_ACTIONS.has(action);
}

/**
 * Execute a built-in action.
 * Returns the step result and optionally a "jumpTo" step ID (for `if` branching).
 */
export async function executeBuiltin(
  step: PresetStep,
  ctx: ExecutionContext,
): Promise<{ result: StepResult; jumpTo?: string }> {
  const start = Date.now();

  switch (step.action) {
    case "if":
      return handleIf(step, ctx, start);
    case "log":
      return handleLog(step, ctx, start);
    case "prompt":
      return handlePrompt(step, ctx, start);
    case "shell":
      return handleShell(step, ctx, start);
    case "set":
      return handleSet(step, ctx, start);
    default:
      throw new Error(`Unknown built-in action: "${step.action}"`);
  }
}

/** if -- evaluate condition expression, return jumpTo target step ID */
function handleIf(
  step: PresetStep,
  ctx: ExecutionContext,
  start: number,
): { result: StepResult; jumpTo?: string } {
  if (!step.condition) {
    throw new Error(`Step "${step.id}": "if" action requires a "condition" field`);
  }

  const conditionResult = resolveExpression(step.condition, ctx);
  const isTruthy = Boolean(conditionResult);
  const jumpTo = isTruthy ? step.then : step.else;

  return {
    result: {
      status: "success",
      output: isTruthy,
      duration: Date.now() - start,
    },
    jumpTo,
  };
}

/** log -- print a resolved message to console via @clack/prompts */
function handleLog(
  step: PresetStep,
  ctx: ExecutionContext,
  start: number,
): { result: StepResult } {
  const params = step.params
    ? resolveParams(step.params as Record<string, unknown>, ctx)
    : {};
  const message = String(params.message ?? "");

  p.log.info(message);

  return {
    result: {
      status: "success",
      output: message,
      duration: Date.now() - start,
    },
  };
}

/** prompt -- ask user a question interactively, store answer as output */
async function handlePrompt(
  step: PresetStep,
  ctx: ExecutionContext,
  start: number,
): Promise<{ result: StepResult }> {
  const params = step.params
    ? resolveParams(step.params as Record<string, unknown>, ctx)
    : {};
  const message = String(params.message ?? "Enter value:");
  const defaultValue = params.default != null ? String(params.default) : undefined;

  const answer = await p.text({
    message,
    placeholder: defaultValue,
    defaultValue,
  });

  if (p.isCancel(answer)) {
    return {
      result: {
        status: "error",
        output: null,
        duration: Date.now() - start,
        error: "User cancelled",
      },
    };
  }

  return {
    result: {
      status: "success",
      output: answer,
      duration: Date.now() - start,
    },
  };
}

/** shell -- run a raw shell command via bash, capture stdout/stderr */
async function handleShell(
  step: PresetStep,
  ctx: ExecutionContext,
  start: number,
): Promise<{ result: StepResult }> {
  const params = step.params
    ? resolveParams(step.params as Record<string, unknown>, ctx)
    : {};
  const command = String(params.command ?? params.cmd ?? "");

  if (!command) {
    throw new Error(`Step "${step.id}": "shell" action requires a "command" param`);
  }

  const cwd = params.cwd ? String(params.cwd) : process.cwd();
  const timeoutMs = params.timeout ? Number(params.timeout) * 1000 : 300_000;

  const proc = Bun.spawn(["bash", "-c", command], {
    cwd,
    stdio: step.interactive ? ["inherit", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Shell command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });

  const [stdout, stderr, exitCode] = await Promise.race([
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]),
    timeoutPromise,
  ]).finally(() => clearTimeout(timer!)) as [string, string, number];

  // Try to parse stdout as JSON for structured access
  let output: unknown = stdout.trim();
  try {
    output = JSON.parse(stdout);
  } catch {
    // Keep as raw string
  }

  return {
    result: {
      status: exitCode === 0 ? "success" : "error",
      output,
      exitCode,
      duration: Date.now() - start,
      error: exitCode !== 0 ? (stderr.trim() || `Exit code: ${exitCode}`) : undefined,
    },
  };
}

/** set -- set key-value pairs into ctx.vars */
function handleSet(
  step: PresetStep,
  ctx: ExecutionContext,
  start: number,
): { result: StepResult } {
  const params = step.params
    ? resolveParams(step.params as Record<string, unknown>, ctx)
    : {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      ctx.vars[key] = value;
    }
  }

  return {
    result: {
      status: "success",
      output: params,
      duration: Date.now() - start,
    },
  };
}
