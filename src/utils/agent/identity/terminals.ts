import { CMUX_IDENTITY_ENV, readCmuxTerminal } from "@genesiscz/utils/cmux/caller-enricher";
import { readTmuxTerminal } from "@genesiscz/utils/tmux/caller-enricher";
import { readTerminalApp } from "./terminal";

/** One terminal a caller may sit in: the variables it sets, and the pure reader of its ids from them. */
export interface TerminalEnricher<T> {
    /** The variables `read` looks at, by name: a remote caller's process env is read by these names. */
    readonly envKeys: readonly string[];
    /** A prefix the terminal owns whole (`CMUX_`), so no other file reads any variable of it. */
    readonly envPrefix?: string;
    /** The source the identity records under `terminal.<id>`. */
    readonly source: string;
    read(env: NodeJS.ProcessEnv): T | undefined;
}

/**
 * Every terminal, one row each, keyed by its id in `CallerTerminals`. A new terminal (WezTerm, Ghostty) is its reader
 * in its own folder (`src/utils/<terminal>/caller-enricher.ts`) and one row here: the identity's terminal slot, its
 * source path `terminal.<id>`, the lint key list (`no-raw-terminal-env`) and the test sandbox's removed keys all read
 * this table. It loads no logger and no I/O module, so the lint script and the test preload import it as data.
 */
export const TERMINAL_ENRICHERS = {
    cmux: { envKeys: CMUX_IDENTITY_ENV, envPrefix: "CMUX_", source: "cmux", read: readCmuxTerminal },
    tmux: { envKeys: ["TMUX_PANE", "TMUX"], source: "tmux", read: readTmuxTerminal },
    app: {
        envKeys: ["TERM_PROGRAM", "ITERM_SESSION_ID", "TERM_SESSION_ID"],
        envPrefix: "ITERM_",
        source: "terminal",
        read: readTerminalApp,
    },
} as const satisfies Record<string, TerminalEnricher<unknown>>;

export type TerminalId = keyof typeof TERMINAL_ENRICHERS;

/** The source each terminal records (`cmux`, `tmux`, `terminal` for the terminal app). */
export type TerminalSource = (typeof TERMINAL_ENRICHERS)[TerminalId]["source"];

/** What each terminal's reader gives, by id. */
export type TerminalSlots = { [Id in TerminalId]: NonNullable<ReturnType<(typeof TERMINAL_ENRICHERS)[Id]["read"]>> };

/** What one terminal's reader gives. */
export type TerminalOf<Id extends TerminalId> = TerminalSlots[Id];

/**
 * Every terminal a caller sits in, at once: a tmux pane inside a cmux surface keeps both. Choosing one to type into
 * is the transport's job (send-self, delivery), never the observer's.
 */
export type CallerTerminals = { [Id in TerminalId]?: TerminalSlots[Id] };

/** The same table, typed per terminal, so a reader's answer keeps its terminal's own type. */
const READERS: { readonly [Id in TerminalId]: TerminalEnricher<TerminalSlots[Id]> } = TERMINAL_ENRICHERS;

export const TERMINAL_IDS = Object.keys(TERMINAL_ENRICHERS) as TerminalId[];

/** Every variable a terminal reader looks at, by name. */
export const TERMINAL_ENV_KEYS: readonly string[] = TERMINAL_IDS.flatMap((id) => READERS[id].envKeys);

/** The variable prefixes a terminal owns whole. */
export const TERMINAL_ENV_PREFIXES: readonly string[] = TERMINAL_IDS.flatMap((id) => {
    const prefix = READERS[id].envPrefix;
    return prefix ? [prefix] : [];
});

/** Whether a variable belongs to a terminal: one a reader names, or one of a family a terminal owns. */
export function isTerminalEnvKey(name: string): boolean {
    return TERMINAL_ENV_KEYS.includes(name) || TERMINAL_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Put one terminal's reading into `into`, typed by its id; nothing when the environment names none. */
export function readTerminalInto<Id extends TerminalId>(id: Id, env: NodeJS.ProcessEnv, into: CallerTerminals): void {
    const value = READERS[id].read(env);

    if (value !== undefined) {
        into[id] = value;
    }
}
