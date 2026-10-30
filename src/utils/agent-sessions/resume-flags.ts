import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessLaunch } from "@genesiscz/utils/ai/providers/harness-index";
import { shellWords } from "@genesiscz/utils/session-changes/words";
import { lastSimpleCommandOnLine } from "@genesiscz/utils/shell/scan";

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
    // The flags each agent accepts and a resume may carry over are its launch recipe's `resumeFlags`.
    const known = harnessLaunch(kind).resumeFlags;
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
