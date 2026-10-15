import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

interface CommandToken {
    value: string;
    start: number;
    end: number;
}

/**
 * Split a command line on top-level whitespace, treating a quoted span as one
 * opaque unit. Quotes are kept in the token so a rewrite can splice the exact
 * original bytes back.
 */
export function tokenizeCommand(command: string): CommandToken[] {
    const tokens: CommandToken[] = [];
    let index = 0;

    while (index < command.length) {
        while (index < command.length && /\s/.test(command[index])) {
            index++;
        }

        if (index >= command.length) {
            break;
        }

        const start = index;
        let quote: string | undefined;

        while (index < command.length) {
            const char = command[index];

            if (quote) {
                if (char === quote) {
                    quote = undefined;
                }

                index++;
                continue;
            }

            if (char === '"' || char === "'") {
                quote = char;
                index++;
                continue;
            }

            if (/\s/.test(char)) {
                break;
            }

            index++;
        }

        tokens.push({ value: command.slice(start, index), start, end: index });
    }

    return tokens;
}

/** Identify the provider named by an agent launcher or supported tool wrapper; return undefined for other commands. */
export function agentKindFromLauncher(command: string): AccountProviderAlias | undefined {
    const trimmed = command.trim();
    const wrapper = toolsRunLauncher(trimmed);
    if (wrapper) {
        return wrapper.kind;
    }
    if (GROK_LAUNCHER.test(trimmed)) {
        return "grok";
    }
    if (CODEX_LAUNCHER.test(trimmed)) {
        return "codex";
    }
    if (launcherRes().claude.test(trimmed)) {
        return "claude";
    }

    return undefined;
}

// Anchored at the START of the command on purpose. `(^|\s)` matched a launcher
// ANYWHERE, so `echo tools cc run` was rewritten wholesale to
// `tools cc run -- --resume <id>` and the original command was lost. The policy
// is that a non-Claude command replays verbatim, so an embedded mention is not
// a launcher.
// `tools claude start` is here because agent-replay emits exactly that form for
// an account-pinned Claude resume. While it was missing, isAgentLauncher said
// false for a command this code had itself written, so the saved command was
// returned verbatim forever: never re-pinned to the session that ran there
// later, and never discarded when the tab turned into a grok tab.
// `(?![\w-])` rather than `\b`: a word boundary sits between "x" and "-", so
// `/^codex\b/` also matched `codex-gateway serve`, and that pane was then
// rewritten into `codex resume <uuid>` on restore.
// A shell wrapper that execs `tools cc run` under another name is a cc run
// launcher too. Every Claude pane on this machine is started through
// `~/.aliases/cr`, so the shell journal records `cr work`; while the regex
// only knew the spelled-out forms, that pane replayed `cr work` verbatim and
// opened a NEW session, although the surface journal had the id all along
// (2026-09-08, every renamed session lost after a reboot).
const CC_RUN_EXEC_RE = /^\s*exec\s+tools\s+(?:cc|claude)\s+run(?![\w-])/m;

/** Names of executable wrappers in `dir` whose body execs `tools cc run`. */
export function discoverCcRunAliases(dir: string): string[] {
    const names: string[] = [];
    try {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            try {
                if (!statSync(path).isFile() || !/^[\w.-]+$/.test(name)) {
                    continue;
                }

                if (CC_RUN_EXEC_RE.test(readFileSync(path, "utf8").slice(0, 4096))) {
                    names.push(name);
                }
            } catch (error) {
                logger.debug({ error, path }, "[command-capture] alias candidate unreadable");
            }
        }
    } catch (error) {
        logger.debug({ error, dir }, "[command-capture] no alias directory to scan");
    }

    return names.sort();
}

let ccRunAliases: string[] | undefined;

/** Override (tests) or reset (`undefined`) the discovered cc run alias names. */
export function setCcRunAliases(names: string[] | undefined): void {
    ccRunAliases = names;
    launchers = undefined;
}

export function ccRunAliasNames(): string[] {
    if (!ccRunAliases) {
        ccRunAliases = discoverCcRunAliases(join(env.tools.getHome(), ".aliases"));
    }

    return ccRunAliases;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Launchers {
    claude: RegExp;
    ccRun: RegExp;
}

let launchers: Launchers | undefined;

export function launcherRes(): Launchers {
    if (!launchers) {
        const aliases = ccRunAliasNames().map(escapeRegExp);
        const ccRun = ["tools (?:cc|claude) run", ...aliases].join("|");
        launchers = {
            claude: new RegExp(`^(?:${ccRun}|tools (?:cc|claude) start|claude)(?![\\w-])`),
            ccRun: new RegExp(`^(?:${ccRun})(?![\\w-])`),
        };
    }

    return launchers;
}

export const GROK_LAUNCHER = /^grok(?![\w-])/;
export const CODEX_LAUNCHER = /^codex(?![\w-])/;
/** `tools <agent> run|start`: the GenesisTools wrapper, which takes an account and passes native args after `--`. */
const TOOLS_RUN_LAUNCHER = /^tools (cc|claude|codex|grok) (?:run|start)(?![\w-])/;

/** The wrapper's agent and where its launcher words end; a cc-run alias (`cr`) is a Claude wrapper too. */
export function toolsRunLauncher(command: string): { kind: AccountProviderAlias; end: number } | undefined {
    const tools = TOOLS_RUN_LAUNCHER.exec(command);

    if (tools) {
        return { kind: tools[1] === "cc" ? "claude" : (tools[1] as AccountProviderAlias), end: tools[0].length };
    }

    const alias = launcherRes().ccRun.exec(command);
    return alias ? { kind: "claude", end: alias[0].length } : undefined;
}

function isSimpleAgentCommand(command: string): boolean {
    let quote: string | undefined;
    for (let index = 0; index < command.length; index++) {
        const char = command[index];
        if (char === "\n" || char === "\r" || char === "`" || (char === "$" && command[index + 1] === "(")) {
            return false;
        }

        if (char === "\\" && quote !== "'") {
            index++;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = undefined;
            }
        } else if (char === "'" || char === '"') {
            quote = char;
        } else if (/[;&|<>()#]/.test(char)) {
            return false;
        }
    }

    return quote === undefined;
}

/** Recognize simple supported agent launches, including configured Claude aliases and tool wrappers. */
export function isAgentLauncher(command: string): boolean {
    const trimmed = command.trim();

    return (
        isSimpleAgentCommand(command) &&
        (TOOLS_RUN_LAUNCHER.test(trimmed) ||
            launcherRes().claude.test(trimmed) ||
            GROK_LAUNCHER.test(trimmed) ||
            CODEX_LAUNCHER.test(trimmed))
    );
}
