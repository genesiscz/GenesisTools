import { existsSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * The three CLI doors to a plan, shared by `control run` and `control workflow run`: a path, `-` for
 * stdin, or the JSON itself. An agent holds the plan in memory, so a temp file as the only way in
 * meant every caller wrote one. `--plan` also takes a path, because `workflow run --plan <file>`
 * shipped first: a value that starts with `{` is the plan, anything else names a file.
 */
export async function readPlanInput({
    positional,
    inline,
    readStdin = () => Bun.stdin.text(),
}: {
    positional?: string;
    inline?: string;
    readStdin?: () => Promise<string>;
}): Promise<unknown> {
    const source = inline ?? positional;

    if (source === undefined) {
        throw new Error("pass a plan file, `-` to read stdin, or --plan '<json>'");
    }

    if (source.trimStart().startsWith("{")) {
        return SafeJSON.parse(source);
    }

    if (source === "-") {
        return SafeJSON.parse(await readStdin());
    }

    if (!existsSync(source)) {
        throw new Error(`plan file not found: ${source}`);
    }

    return SafeJSON.parse(readFileSync(source, "utf-8"));
}
