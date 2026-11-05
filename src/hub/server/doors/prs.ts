import { asResult } from "@genesiscz/utils/cli/result";
import { summarizeHostError } from "@genesiscz/utils/git/origins";
import { parseArgv, stringFlag, wholeNumber } from "../argv";
import { type CallDoor, failed, ok } from "./types";

interface PrShowArgs {
    ref: string;
    maxCacheAgeSeconds: number;
    headSha?: string;
}

/**
 * `hub pr show <ref> [--max-cache-age N] [--head <sha>]`: one PR's detail, what a hub PR link opens first. As a
 * process it paid a cold `tools` start before the forge call: 1.8 s of the 2.7 s from a link to its PR on screen
 * (2026-11-02 18:08). Read-only: the forge answer and its cache, as the CLI command.
 */
export const prShowDoor: CallDoor<PrShowArgs> = {
    kind: "call",
    name: "hub pr show",
    command: ["hub", "pr", "show"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["hub", "pr", "show"],
            positionals: 1,
            flags: { "--max-cache-age": "value", "--head": "value" },
        });
        if (!parsed) {
            return null;
        }

        const age = parsed.flags.has("--max-cache-age") ? wholeNumber(parsed.flags.get("--max-cache-age")) : 0;
        if (age === null || !/^https?:\/\//.test(parsed.positionals[0])) {
            return null;
        }

        return { ref: parsed.positionals[0], maxCacheAgeSeconds: age, headSha: stringFlag(parsed, "--head") };
    },
    async run(args, { signal }) {
        try {
            signal.throwIfAborted();
            const { hubPr, PrRefError } = await import("../../lib/prs");
            try {
                return ok(asResult(await hubPr(args)));
            } catch (error) {
                if (!(error instanceof PrRefError)) {
                    throw error;
                }

                // As the CLI: the JSON error on stdout and exit 1, so the app shows the short line.
                const body = {
                    ref: args.ref,
                    error: error.message,
                    errorSummary: summarizeHostError(error.message, null),
                };
                return { stdout: asResult(body), stderr: `${error.message}\n`, exit: 1 };
            }
        } catch (error) {
            return failed(error);
        }
    },
};
