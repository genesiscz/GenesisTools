import { ACCOUNT_PROVIDER_ALIASES, type AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { Option } from "commander";

/** `--provider [name]` of a `tools ai sessions` verb: the value may be left out, so the harness list can answer. */
export function sessionProviderOption(
    description = `${ACCOUNT_PROVIDER_ALIASES.join(" | ")} (auto-detect if omitted)`
): Option {
    return new Option("--provider [name]", description);
}

/**
 * The harness `--provider` names. No flag gives undefined (auto-detect). `--provider` with no value lets a TTY pick;
 * an unknown value, or no TTY, prints the values with a corrected command, sets exit code 1 and returns undefined.
 * `verb` is the words after `tools ai`, e.g. ["sessions", "workflows", "list"].
 */
export async function pickSessionProvider(
    given: string | boolean | undefined,
    verb: string[]
): Promise<{ provider: AccountProviderAlias | undefined } | undefined> {
    if (given === undefined) {
        return { provider: undefined };
    }

    const known = ACCOUNT_PROVIDER_ALIASES.find((alias) => alias === given);
    if (known) {
        return { provider: known };
    }

    if (given !== true || !isInteractive()) {
        out.printlnErr(
            suggestEnumFlag(`tools ai ${verb.join(" ")}`, "--provider", ACCOUNT_PROVIDER_ALIASES, {
                subcommand: verb,
                given: typeof given === "string" ? given : undefined,
            })
        );
        process.exitCode = 1;
        return undefined;
    }

    const picked = await p.select({
        message: "Harness",
        options: ACCOUNT_PROVIDER_ALIASES.map((value) => ({ value, label: value })),
        cancel: "back",
    });
    return p.isCancel(picked) ? undefined : { provider: picked };
}
