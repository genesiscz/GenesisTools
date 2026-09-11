import type { AgentSession, AgentSessionAdapter } from "@genesiscz/utils/agent-sessions/types";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import type { WorkerDriver } from "@genesiscz/utils/worker/driver";
import type { Command } from "commander";

/**
 * One plain object per coding-agent tool, consumed by `registerAgentTool`.
 *
 * The data layers are shared already (one plugin registry, one history index, one account
 * store). This is the CLI half: the shared verbs read their flags and render their output
 * ONCE, and a tool contributes only what genuinely differs, in three named places: extra
 * flags through `extendRun` / `extendSpawn`, behaviour inside the launcher and the worker
 * driver, and a declared `overrides` entry when a verb means something else on that tool.
 * A deviation is therefore visible in the spec, never accidental in a copied command file.
 */

/** Verbs every coding-agent tool answers the same way. */
export type SharedVerb = "run" | "resume" | "history" | "login" | "warmup" | "usage" | "who" | "worker";

export interface AgentLaunchInput {
    account: AccountEntry;
    /** Resolved by the shared selector when `--resume <query>` was given. */
    session?: AgentSession;
    /** `--resume` with no value: the native binary's own picker. */
    nativeResume: boolean;
    /** `-c, --continue`: the native "most recent session" switch. */
    continueLast: boolean;
    model?: string;
    /** The session's recorded directory when it still exists, else the requested one. */
    cwd: string;
    /** Native arguments the wrapper forwards verbatim. */
    passthrough: string[];
    /** Every option commander parsed, the `extendRun` extras included. */
    flags: Record<string, unknown>;
}

export interface AgentLauncher {
    /** Tool-specific `run` flags: codex `--home --computer-use`; grok's legacy worker flags. */
    extendRun?(command: Command): void;
    /**
     * Runs before any account or session is resolved. Throw to refuse argv; return `"handled"`
     * when the invocation was a compatibility route (grok `run --name` is the headless worker)
     * or a listing, so the launch never starts.
     */
    preflight?(input: { flags: Record<string, unknown>; passthrough: string[] }): Promise<"handled" | undefined>;
    /**
     * Where a `--resume <query>` is looked up. Default: the spec's adapter over every known
     * home. Codex narrows the roots to its `--home` and prefers that home's copies.
     */
    resumeScope?(input: { flags: Record<string, unknown> }): Promise<{
        adapter: AgentSessionAdapter;
        preferredHome?: string;
    }>;
    /** Open the interactive native TUI as the account. Sets `process.exitCode`; never exits. */
    launch(input: AgentLaunchInput): Promise<void>;
}

export interface AgentToolSpec {
    /** CLI alias. Also the env-var stem (`TOOLS_KIMI_ACCOUNT`), the history kind, the worker backend. */
    alias: AccountProviderAlias;
    /** Plugin id. Supplies `accounts` (login, usage, homes) and `codingAgent` (history reader). */
    provider: string;
    /** One line for `tools <alias> --help`. */
    description: string;
    /** History + resume data. Defaults to `createNativeHistoryAdapter({ kind: alias, provider })`. */
    adapter?: () => AgentSessionAdapter;
    launcher: AgentLauncher;
    /** Headless worker driver. Absent: the worker verbs are the declared erroring stubs. */
    worker?: WorkerDriver;
    /** Where the worker verbs mount. Default bare (`tools kimi spawn`); Claude passes "worker". */
    workerMount?: string;
    /** One line for the `worker` group itself, when `workerMount` is set. */
    workerMountDescription?: string;
    /**
     * How `who` recognises this agent's processes on the `ps` table. Absent: no `who` verb,
     * which is the honest answer for an agent whose launcher exports no account.
     */
    processScan?: {
        classify(args: string): string | null;
        /** Kinds that are machinery rather than billable sessions; hidden unless `--all`. */
        helperKinds?: readonly string[];
    };
    /** Per-tool `--help` wording for the pinned doors; each has a usable default. */
    help?: {
        usage?: string;
        login?: string;
    };
    /** Verbs the tool implements itself. Declared here so a deviation is visible, never accidental. */
    overrides?: Partial<Record<SharedVerb, (program: Command, spec: AgentToolSpec) => void>>;
}

export function toolName(spec: AgentToolSpec): string {
    return `tools ${spec.alias}`;
}
