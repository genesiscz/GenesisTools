// src/automate/lib/types.ts

/** Variable definition in a preset */
export interface PresetVariable {
  type: "string" | "number" | "boolean";
  description: string;
  default?: string | number | boolean;
  required?: boolean;
}

/** Error handling strategy */
export type OnError = "stop" | "continue" | "skip";

/** Trigger type -- manual only for v1, extensible later */
export interface PresetTrigger {
  type: "manual";
}

/** A single step in the preset */
export interface PresetStep {
  /** Unique identifier for the step (alphanumeric, hyphens, underscores) */
  id: string;
  /** Human-readable step name shown in progress output */
  name: string;
  /** "tools <cmd>" subcommand (e.g. "github search") OR built-in: "if" | "log" | "prompt" | "shell" | "set" */
  action: string;
  /** Parameters passed to the action. Keys starting with -- become flags; others are positional args. Values can contain {{ expressions }}. */
  params?: Record<string, unknown>;
  /** Variable name to store stdout/result in ctx.steps[id] */
  output?: string;
  /** What to do on failure. Default: "stop" */
  onError?: OnError;
  /** If true, subprocess inherits stdin for interactive prompts */
  interactive?: boolean;
  /** For "if" action: expression string returning boolean (e.g. "{{ steps.x.output.count > 0 }}") */
  condition?: string;
  /** For "if" action: step ID to jump to when condition is truthy */
  then?: string;
  /** For "if" action: step ID to jump to when condition is falsy */
  else?: string;
}

/** The full preset document (JSON schema) */
export interface Preset {
  /** Schema identifier for format versioning */
  $schema: string;
  /** Preset display name */
  name: string;
  /** Optional description of what this preset does */
  description?: string;
  /** Trigger configuration (manual only in v1) */
  trigger: PresetTrigger;
  /** Variable definitions with types, descriptions, and defaults */
  vars?: Record<string, PresetVariable>;
  /** Ordered list of steps to execute */
  steps: PresetStep[];
}

/** Runtime context passed through execution */
export interface ExecutionContext {
  /** User-defined variables (from preset defaults + CLI overrides + prompts) */
  vars: Record<string, string | number | boolean>;
  /** Results from previously executed steps, keyed by step ID */
  steps: Record<string, StepResult>;
  /** Process environment variables */
  env: Record<string, string>;
}

/** Result of a single step execution */
export interface StepResult {
  status: "success" | "error" | "skipped";
  /** Parsed JSON if possible, raw string otherwise */
  output: unknown;
  exitCode?: number;
  /** Duration in milliseconds */
  duration: number;
  error?: string;
}

/** Run options from CLI flags */
export interface RunOptions {
  dryRun?: boolean;
  /** ["key=value", ...] from --var flags */
  vars?: string[];
  verbose?: boolean;
}

/** Metadata stored alongside presets for `list` command */
export interface PresetMeta {
  /** ISO date of last run */
  lastRun?: string;
  runCount?: number;
}

// ---------------------------------------------------------------------------
// Step Action Types (for type-safe action strings)
// ---------------------------------------------------------------------------

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
export type FileAction = "read" | "write" | "copy" | "move" | "delete" | "glob" | "template";
export type GitAction = "status" | "commit" | "branch" | "diff" | "log";
export type JsonAction = "parse" | "stringify" | "query";
export type TextAction = "regex" | "template" | "split" | "join";
export type ArrayAction = "filter" | "map" | "sort" | "flatten";
export type NotifyAction = "desktop" | "clipboard" | "sound";

// ---------------------------------------------------------------------------
// Step Params per Action Type
// ---------------------------------------------------------------------------

export interface HttpStepParams {
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  credential?: string;
  timeout?: number;
  validateStatus?: string;
}

export interface FileStepParams {
  path?: string;
  content?: string;
  source?: string;
  destination?: string;
  pattern?: string;
  cwd?: string;
  templatePath?: string;
  variables?: Record<string, string>;
  encoding?: "utf-8" | "base64";
}

export interface GitStepParams {
  cwd?: string;
  message?: string;
  files?: string[];
  branch?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface JsonStepParams {
  input?: string;
  query?: string;
  indent?: number;
}

export interface TextStepParams {
  input?: string;
  pattern?: string;
  replacement?: string;
  flags?: string;
  template?: string;
  separator?: string;
}

export interface ArrayStepParams {
  input?: string;
  expression?: string;
  key?: string;
  order?: "asc" | "desc";
  initial?: unknown;
}

export interface NotifyStepParams {
  title?: string;
  message?: string;
  content?: string;
  sound?: string;
}

export interface ParallelStepParams {
  steps: string[];
  onError?: "stop" | "continue";
}

export interface ForEachStepParams {
  items: string;
  step: PresetStep;
  concurrency?: number;
  as?: string;
  indexAs?: string;
}

export interface WhileStepParams {
  condition: string;
  step: PresetStep;
  maxIterations?: number;
}

// ---------------------------------------------------------------------------
// Credential Types
// ---------------------------------------------------------------------------

export type CredentialType = "bearer" | "basic" | "apikey" | "custom";

export interface StoredCredential {
  name: string;
  type: CredentialType;
  token?: string;
  username?: string;
  password?: string;
  headerName?: string;
  key?: string;
  headers?: Record<string, string>;
}
