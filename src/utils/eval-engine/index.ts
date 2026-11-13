// Copied from /Users/Martin/Tresors/Projects/Kalendora/src/eval-engine/index.ts at 2026-11-12T06:18:59+01:00 at commit hash 2b9937db296fcb22d402376689d926a71fe9f165
/**
 * eval-engine: a project-agnostic engine that plays scenario conversations against a system, checks every answer,
 * and writes transcripts. A project learns five names: `defineEvalSystem`, `evalKit`, `defineEvalProject`,
 * `createEvalCommand` and `EvalSystemError`. The quickstart is README.md beside this file.
 */
export { createEvalCommand, type EvalIo } from "./cli";
export type { CellRef, ConversationRecord, TurnRecord } from "./conversation";
export {
    type ArgsMatch,
    type Check,
    type CheckBuilder,
    type ChooseStep,
    type CodeCheck,
    EvalConfigError,
    type EvalKit,
    type Expectation,
    evalKit,
    type MatrixDoc,
    type Scenario,
    type ScenarioDoc,
    type ScenarioIssue,
    type ScenarioSpec,
    type ScriptedStep,
    type Severity,
    type SimulatedStep,
    type Step,
    sha256,
    type TextMatch,
    toJson,
    type ValueMatch,
} from "./document";
export type { ExpectationVerdict, Outcome } from "./evaluate";
export { defineEvalProject, type EvalProject, type RunEvalOptions, type RunEvalRequest, runEval } from "./project";
export { type CellStats, type Comparison, compareEvalRuns, ExitCode, type RunSummary } from "./report";
export { loadRun, type RunView } from "./store";
export {
    type CleanupItem,
    type CloseOutcome,
    type Completion,
    type CompletionRequest,
    defineEvalSystem,
    type EvalSystem,
    EvalSystemError,
    type Json,
    type ModelRef,
    type ModelStep,
    type OpenRequest,
    type ResolveContext,
    type SignalsSchema,
    type SystemConnection,
    type SystemInfo,
    type ToolCall,
    type TurnResult,
    type Usage,
} from "./system";
