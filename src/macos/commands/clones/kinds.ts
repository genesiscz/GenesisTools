import { isInteractive, parseVariadic, suggestEnumFlag } from "@genesiscz/utils/cli";
import * as p from "@genesiscz/utils/prompts/p";

/** Resolve an enumerated flag that may arrive empty (`--targets` with no
 *  value). Returns null when the caller should stop: the possible values were
 *  printed, or the prompt was cancelled. Shared by `reclaim` and `optimize`,
 *  which used to answer a bare `--targets` two different ways. */
export async function resolveKinds(args: {
    raw: string | boolean | undefined;
    fallback: string[];
    flag: string;
    values: readonly string[];
    subcommand: string[];
}): Promise<string[] | null> {
    if (args.raw === undefined) {
        return args.fallback;
    }

    if (typeof args.raw === "string") {
        return parseVariadic(args.raw);
    }

    if (!isInteractive()) {
        console.error(suggestEnumFlag("tools macos clones", args.flag, args.values, { subcommand: args.subcommand }));
        process.exitCode = 1;
        return null;
    }

    const picked = await p.multiselect({
        message: `Which ${args.flag} do you want?`,
        options: args.values.map((v) => ({ value: v, label: v })),
        required: true,
    });
    if (p.isCancel(picked)) {
        p.cancel("Aborted.");
        return null;
    }

    return picked.map(String);
}
