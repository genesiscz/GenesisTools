import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { shellWords } from "@genesiscz/utils/session-changes/words";
import { lastSimpleCommandOnLine } from "@genesiscz/utils/shell/scan";

/** How a flag takes its value: none, a required next word (or `=value`), or only an `=value`. */
type Arity = "none" | "value" | "optional";

/**
 * The flags each agent itself accepts and a resume may carry over, read from `claude --help`, `grok --help` and
 * `codex resume --help` (claude 2.1, grok 1.x, codex 0.13x, 2026-10-15). Left out on purpose: the model
 * (`-m`, `--model`, `--fallback-model`: a session can switch models, so the tab's start flag would pin the wrong
 * one), every resume, continue, fork and session-id flag (the resume sets its own), headless output (`-p`,
 * `--print`, `--output-format`), the directory (the restore types its own `cd`), and help or version.
 */
const AGENT_FLAGS: Record<AccountProviderAlias, Record<string, Arity>> = {
    claude: {
        "--add-dir": "value",
        "--agent": "value",
        "--agents": "value",
        "--allow-dangerously-skip-permissions": "none",
        "--allowedTools": "value",
        "--allowed-tools": "value",
        "--append-system-prompt": "value",
        "--autocompact": "value",
        "--bare": "none",
        "--betas": "value",
        "--brief": "none",
        "--chrome": "none",
        "--dangerously-skip-permissions": "none",
        "-d": "optional",
        "--debug": "optional",
        "--debug-file": "value",
        "--disable-slash-commands": "none",
        "--disallowedTools": "value",
        "--disallowed-tools": "value",
        "--effort": "value",
        "--ide": "none",
        "--mcp-config": "value",
        "--no-chrome": "none",
        "--permission-mode": "value",
        "--plugin-dir": "value",
        "--restricted": "none",
        "--safe-mode": "none",
        "--setting-sources": "value",
        "--settings": "value",
        "--strict-mcp-config": "none",
        "--system-prompt": "value",
        "--tools": "value",
    },
    grok: {
        "--agent": "value",
        "--agents": "value",
        "--allow": "value",
        "--always-approve": "none",
        "--debug": "none",
        "--debug-file": "value",
        "--deny": "value",
        "--disable-web-search": "none",
        "--disallowed-tools": "value",
        "--fullscreen": "none",
        "--max-turns": "value",
        "--minimal": "none",
        "--no-alt-screen": "none",
        "--no-plan": "none",
        "--no-subagents": "none",
        "--permission-mode": "value",
        "--reasoning-effort": "value",
        "--rules": "value",
        "--sandbox": "value",
        "--tools": "value",
    },
    codex: {
        "-a": "value",
        "--add-dir": "value",
        "--approve-for-me": "none",
        "--ask-for-approval": "value",
        "-c": "value",
        "--config": "value",
        "--dangerously-bypass-approvals-and-sandbox": "none",
        "--dangerously-bypass-hook-trust": "none",
        "--disable": "value",
        "--enable": "value",
        "--local-provider": "value",
        "--no-alt-screen": "none",
        "--no-daemon": "none",
        "--oss": "none",
        "-p": "value",
        "--profile": "value",
        "-s": "value",
        "--sandbox": "value",
        "--search": "none",
        "--strict-config": "none",
    },
};

export interface CarriedFlags {
    /** Argv words to append to the resume, in their typed order. */
    kept: string[];
    /** Flags the agent does not list, or a resume must not carry, as typed. */
    dropped: string[];
    /** Recognized flags omitted because their shell expansions cannot be recovered as concrete argv. */
    unresolved: string[];
}

/**
 * The agent flags of a typed line whose launcher the restore does not know (an alias such as `ffff`): only flags
 * the agent itself lists survive, because a wrapper's own flag (`--cross-messages` of `tools claude run`) makes
 * the agent refuse to start. Words that are not flags (an account, a prompt) are not carried. Only the last
 * simple command counts, so `cd x && ffff --chrome` carries `--chrome`.
 */
export function carryAgentFlags(kind: AccountProviderAlias, command: string): CarriedFlags {
    const args = shellWords(lastSimpleCommandOnLine(command)).slice(1);
    const known = AGENT_FLAGS[kind];
    const kept: string[] = [];
    const dropped: string[] = [];
    const unresolved: string[] = [];

    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        const word = argument?.value ?? "";

        if (word === "--" || !word.startsWith("-")) {
            continue;
        }

        const [name, inline] = word.startsWith("--") && word.includes("=") ? word.split(/=(.*)/s) : [word, undefined];
        const arity = known[name ?? ""];
        const next = args[index + 1];
        const takesNext = inline === undefined && arity === "value" && next !== undefined && next.value !== "--";

        if (arity === undefined) {
            dropped.push(word);
            continue;
        }

        if (argument?.dynamic || (takesNext && next.dynamic)) {
            unresolved.push(takesNext ? `${word} ${next.value}` : word);
            if (takesNext) {
                index++;
            }

            continue;
        }

        kept.push(word);

        if (takesNext) {
            kept.push(next.value);
            index++;
        }
    }

    return { kept, dropped, unresolved };
}
