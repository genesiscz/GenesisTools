import { suggestCommand } from "@app/utils/cli";

export interface ResolveInputOptions {
    /** The positional argument: a file path, "-" for stdin, or undefined. */
    arg: string | undefined;
    /** Whether process.stdin is a TTY (no piped input available). */
    isTTY: boolean;
}

export interface ResolvedInput {
    text: string;
}

/**
 * Resolve the JSON text from the chosen source:
 *  - explicit file path        → read the file
 *  - "-"                        → read stdin
 *  - no arg + piped stdin       → read stdin
 *  - no arg + TTY stdin         → throw guidance (never block)
 */
export async function resolveInput({ arg, isTTY }: ResolveInputOptions): Promise<ResolvedInput> {
    const fromStdin = arg === "-" || (arg === undefined && !isTTY);

    if (fromStdin) {
        const text = await Bun.stdin.text();
        return { text };
    }

    if (arg === undefined) {
        const hint = suggestCommand("tools json schema", { add: ["<file.json>"] });
        throw new Error(`No input. Pass a JSON file, "-", or pipe JSON in.\n${hint}`);
    }

    const file = Bun.file(arg);
    if (!(await file.exists())) {
        throw new Error(`File not found: ${arg}`);
    }

    const text = await file.text();
    return { text };
}
