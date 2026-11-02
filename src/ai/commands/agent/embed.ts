import { embedLauncher } from "@app/ai/lib/embed/registry";
import { embedAccountEnvVar, parseEmbedAccountRequest } from "@genesiscz/utils/ai/account-env";
import { env } from "@genesiscz/utils/env";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

/**
 * Splits an embed launch: the native argv is everything after the first `--`, and the account is the one operand
 * between `embed` and `--`. Commander would bind the first native operand to `[account]` (it does so even after
 * `--`), and the host's own flags (`--output-format`, `app-server`, `--resume=<id>`) must never reach it, so the
 * launcher scripts always pass `--`. Null when there is no `--`.
 *
 * The verb is the FIRST `embed` after the runtime and the script path: the account operand comes after it and may
 * itself be named `embed` (`tools claude embed embed -- …`).
 */
export function splitEmbedArgv(argv: readonly string[]): { account: string | undefined; native: string[] } | null {
    const dash = argv.indexOf("--");

    if (dash < 0) {
        return null;
    }

    const verb = argv.slice(0, dash).indexOf("embed", 2);
    const operands = verb < 0 ? [] : argv.slice(verb + 1, dash).filter((token) => !token.startsWith("-"));

    return { account: operands[0], native: argv.slice(dash + 1) };
}

/** `tools <agent> embed [account] -- <native args>`: the binary path an embedding app (T3 Code) runs. */
export function registerEmbedCommand(program: Command, alias: HarnessId): Command {
    const variable = embedAccountEnvVar(alias);

    return program
        .command("embed [account]")
        .description(
            `Run ${alias} for an app that embeds it (T3 Code) as one account. [account], else ${variable}: ` +
                "an account name, auto, or proxy:<account>/<provider>. Everything after -- goes to the native binary."
        )
        .allowUnknownOption(true)
        .allowExcessArguments(true)
        .action(async () => {
            const split = splitEmbedArgv(process.argv);

            if (split === null) {
                out.error(`tools ${alias} embed needs -- before the native arguments.`);
                process.exitCode = 2;
                return;
            }

            const request = parseEmbedAccountRequest(split.account ?? env.get(variable));
            logger.info({ alias, request, args: split.native.length }, "[embed] launch");
            const launcher = await embedLauncher(alias);
            await launcher.run({ request, argv: split.native });
        });
}
