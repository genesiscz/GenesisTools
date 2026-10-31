// Helpers every feature of this plugin shares: the host the features reach the engine through, where GenesisTools
// keeps its files, the `mods.*` switches of the hooks file, and the per-feature log the features write so their
// heuristics can be improved from real use.
//
// 🛑 Only `register.tsx` sees `$`. `claude plugin validate` refuses `$` passed into a function another file declares,
// and a `read`/`update` of an atom another file declares (checked 2026-10-23), so a feature file gets a `Host`: the
// closures `register.tsx` builds over `$`, each spelled `$.noun.method(...)` there. A feature keeps its state in
// module variables and calls `host.redraw()` after a change, which draws this plugin's `ui.render` hooks again.
import type {
    AgentInfo,
    CommandRunResult,
    FsEntry,
    FsStat,
    ProcessRunInit,
    ProcessRunResult,
    PromptAutocompleteInput,
    PromptAutocompleteSuggestion,
    PromptFillArgs,
    ToolCallInput,
    TurnCompleteInput,
    UiCopyResult,
    UiScrollResult,
} from "claude-code";
import { MODS_DEFAULTS, type ModsSettings, modsSettings } from "./settings";
import type { Sidebar } from "./sidebar";

export { isRecord, MODS_DEFAULTS, type ModsSettings, modsSettings } from "./settings";

/** A JSON text's value; undefined for no text, or text that does not parse (a file another session is writing). */
export function jsonOf(text: string | undefined): unknown {
    if (!text) {
        return undefined;
    }

    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/** The JSON a command printed; undefined when it did not run, failed, or printed no JSON. */
export function jsonOfRun(done: { exitCode: number; stdout: string } | undefined): unknown {
    return done?.exitCode === 0 ? jsonOf(done.stdout) : undefined;
}

/** A JSON file's value; undefined when it cannot be read or does not parse. */
export async function readJsonFile(host: Host, path: string): Promise<unknown> {
    return jsonOf(await host.read(path).catch(() => undefined));
}

export interface Host {
    run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>;
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<void>;
    /** Adds `text` at the end of a file, making it and its folder when missing; rejects when the write failed. */
    append: (path: string, text: string) => Promise<void>;
    list: (path: string) => Promise<FsEntry[]>;
    exists: (path: string) => Promise<boolean>;
    stat: (path: string) => Promise<FsStat>;
    /** The validator lists every variable a module reads, so the names are fixed. */
    env: (name: "HOME" | "GENESIS_TOOLS_HOME") => Promise<string | undefined>;
    cwd: () => Promise<string>;
    sessionId: () => Promise<string>;
    messages: () => Promise<readonly { role: string; text: string }[]>;
    agents: () => Promise<AgentInfo[]>;
    every: (ms: number, fn: () => void) => void;
    /** Resolves after `ms` on the engine clock. Optional so a test host may leave it out; without it nothing waits. */
    sleep?: (ms: number) => Promise<void>;
    storeGet: (key: string) => Promise<unknown>;
    storeSet: (key: string, value: unknown) => Promise<void>;
    status: (text: string | undefined) => void;
    fill: (args: PromptFillArgs) => Promise<unknown>;
    submit: (text: string) => Promise<unknown>;
    /** Opens a sidebar: docked beside the transcript in fullscreen, a dialog with the keyboard (Esc closes) otherwise. */
    openPane: (id: string, title: string, from?: "command" | "band") => Promise<unknown>;
    /** Closes the sidebar when it shows, else opens it: what a press on its band chip does. */
    togglePane: (id: string, title: string, from?: "command" | "band") => Promise<unknown>;
    closePane: (id: string) => Promise<unknown>;
    copy: (text: string) => Promise<UiCopyResult>;
    /**
     * Scrolls a transcript row into view, its top at the window's top: a message by its transcript `uuid`, a tool
     * call by its id. The engine moves a transcript row only while the call answers the person's own press.
     */
    scroll: (requestId: string) => Promise<UiScrollResult>;
    /** Opens a URL with macOS `open`: a browser page, or a genesis.tools route. */
    openUrl: (url: string) => Promise<unknown>;
    /** A short notice that fades by itself. */
    toast: (text: string) => void;
    /** Draws this plugin's `ui.render` hooks again, so a band or pane shows the state just changed. */
    redraw: () => void;
}

/** `<home>/.genesis-tools/agents`; `GENESIS_TOOLS_HOME` replaces the home, as it does for every tool. */
export async function agentsDir(host: Host): Promise<string | undefined> {
    const home = (await host.env("GENESIS_TOOLS_HOME")) ?? (await host.env("HOME"));

    return home ? `${home}/.genesis-tools/agents` : undefined;
}

export async function readHooksFile(host: Host, dir: string | undefined): Promise<string | undefined> {
    return dir ? host.read(`${dir}/hooks.json`).catch(() => undefined) : undefined;
}

let cached: { at: number; value: ModsSettings } | undefined;

/** `modsSettings` of the hooks file, read at most every 10 s: a band redraws often, and the file changes rarely. */
export async function settingsOf(host: Host): Promise<ModsSettings> {
    const now = Date.now();

    if (cached && now - cached.at < 10_000) {
        return cached.value;
    }

    const value = modsSettings(await readHooksFile(host, await agentsDir(host)));
    cached = { at: now, value };

    return value;
}

/**
 * The settings as last read, without waiting: the defaults before the first read. For a press, whose engine calls must
 * come before any await (`register.tsx`, `showPane`).
 */
export function settingsNow(): ModsSettings {
    return cached?.value ?? MODS_DEFAULTS;
}

/** Drops the remembered settings: a test sets up another hooks file. */
export function forgetSettings(): void {
    cached = undefined;
}

/** Appends one JSON line, `at` first, to a `.jsonl` file (`Host.append`); a line that could not be written is dropped. */
/**
 * Lines waiting for one append per file. Each append is a shell (`cat >>` in `register.tsx`), and in the quiet
 * 15:00 to 18:00 of 2026-10-30 the mods' own logs made 2,315 of the 14,746 processes of 20 sessions. A file now
 * gets every line of the last 10 s in one write; a host without a clock (a test) writes each line at once. A reload
 * of the mods drops the lines still waiting, at most 10 s of a log.
 */
const queuedLog = new Map<string, string[]>();
const inFlightLog = new Map<string, Promise<void>>();
const LOG_FLUSH_MS = 10_000;
const LOG_FLUSH_LINES = 100;

async function flushLog(host: Host, path: string): Promise<void> {
    const lines = queuedLog.get(path);
    queuedLog.delete(path);

    if (lines && lines.length > 0) {
        const previous = inFlightLog.get(path) ?? Promise.resolve();
        const pending = previous.then(() => host.append(path, lines.join(""))).catch(() => undefined);
        inFlightLog.set(path, pending);
        await pending;
        if (inFlightLog.get(path) === pending) {
            inFlightLog.delete(path);
        }
    } else {
        await inFlightLog.get(path);
    }
}

/** Every waiting log line written now: the session ends. */
export async function flushModLogs(host: Host): Promise<void> {
    const paths = new Set([...queuedLog.keys(), ...inFlightLog.keys()]);
    await Promise.all([...paths].map((path) => flushLog(host, path)));
}

export async function appendJsonl(host: Host, path: string, record: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;

    if (!host.sleep) {
        await host.append(path, line).catch(() => undefined);
        return;
    }

    const waiting = queuedLog.get(path);

    if (waiting) {
        waiting.push(line);

        if (waiting.length >= LOG_FLUSH_LINES) {
            await flushLog(host, path);
        }

        return;
    }

    queuedLog.set(path, [line]);
    void host.sleep(LOG_FLUSH_MS).then(() => flushLog(host, path));
}

/**
 * Appends one JSON line to `<agents>/mods-log/<feature>.jsonl`, the record of what a feature did, so its heuristics
 * can be checked against what the person then did.
 */
export async function logMod(host: Host, feature: string, record: Record<string, unknown>): Promise<void> {
    const dir = await agentsDir(host);

    if (dir) {
        await appendJsonl(host, `${dir}/mods-log/${feature}.jsonl`, record);
    }
}

/** A routine reading (a refresh's rows, a measure): logged only with `mods.log.readings` on. */
export async function logReading(host: Host, feature: string, record: Record<string, unknown>): Promise<void> {
    if ((await settingsOf(host)).log.readings) {
        await logMod(host, feature, record);
    }
}

/**
 * When a periodic reader may run again: `everyMs` after its start, or ten times the run's own length when that is
 * longer. A command that turns slow because the Mac is loaded is asked less often, instead of adding to the load.
 */
export function paceAfter(everyMs: number, startedAt: number, now = Date.now()): number {
    return startedAt + Math.max(everyMs, (now - startedAt) * 10);
}

/** `12s`, `4m 05s`, `1h 02m`. */
export function shortDuration(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));

    if (s < 60) {
        return `${s}s`;
    }

    if (s < 3600) {
        return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
    }

    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/**
 * One feature's part in the events several features share. The engine takes one unmatched hook per event from a
 * plugin, so `register.tsx` holds that hook and calls each feature's part in turn.
 */
export interface Feature {
    /** Only draws for a person (a band, a sidebar): skipped in a session nobody watches (`-p`, the SDK). */
    panelOnly?: boolean;
    /** On session start: start timers, take a first reading. */
    start?: (host: Host) => Promise<void>;
    /** Slash commands, registered at session start and answered by `command.run`. */
    commands?: {
        name: string;
        description: string;
        argumentHint?: string;
        run: (host: Host, args: string) => Promise<CommandRunResult>;
    }[];
    /** Before a tool call runs; the function it returns runs when the call has ended, however it ended. */
    beforeTool?: (host: Host, e: ToolCallInput) => (() => void) | undefined;
    /** After a tool call answered. */
    afterTool?: (host: Host, e: ToolCallInput) => Promise<void>;
    /** As a loop sends a model request (`e.agentId` set for a subagent's); the request does not wait for it. */
    beforeStep?: (host: Host, e: { agentId?: string }) => Promise<void>;
    /** After a turn completed, the main loop's or a subagent's (`e.agentId`). */
    afterTurn?: (host: Host, e: TurnCompleteInput) => Promise<void>;
    /** After a loop compacted (the main loop when `agentId` is undefined). */
    compacted?: (host: Host, agentId: string | undefined) => void | Promise<void>;
    /** The sidebars it opens from the band (`sidebar.tsx`). */
    sidebars?: Sidebar[];
    /** Rows for the prompt's typeahead as the person types (`prompt.autocomplete`); none for most tokens. */
    autocomplete?: (host: Host, e: PromptAutocompleteInput) => Promise<PromptAutocompleteSuggestion[]>;
}

/** Each tool call's input as text, built once for every feature that asks which paths it names. */
const callTexts = new WeakMap<ToolCallInput, string>();

/** The paths among `paths` a tool call names anywhere in its input. */
export function namedPaths(e: ToolCallInput, paths: readonly string[]): string[] {
    const text = callTexts.get(e) ?? JSON.stringify(e);
    callTexts.set(e, text);

    return paths.filter((path) => text.includes(path));
}

/** Post-call bookkeeping keeps its order while the tool result and its progress cleanup return immediately. */
export function afterTools({
    host,
    event,
    features,
}: {
    host: Host;
    event: ToolCallInput;
    features: readonly Feature[];
}): void {
    void (async () => {
        for (const feature of features) {
            try {
                await feature.afterTool?.(host, event);
            } catch (error) {
                await logMod(host, "tools", { event: "after-tool-failed", error: String(error) }).catch(
                    () => undefined
                );
            }
        }
    })();
}
