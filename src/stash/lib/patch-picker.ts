import { logger } from "@app/logger";

const { log } = logger.scoped("stash:patch-picker");

export interface PatchPickerArgs {
    patch: string;
}

export interface PatchPickerResult {
    kept: string;
    droppedCount: number;
}

interface FileBlock {
    filePath: string;
    headerLines: string[];
    hunks: Array<{ headerLine: string; body: string }>;
}

interface SelectOption {
    value: string;
    label: string;
}

interface PromptOverride {
    select: (opts: { message: string; options: SelectOption[] }) => Promise<string | symbol>;
    note: (message: string, title?: string) => void;
}

export async function pickPatchInteractively(
    args: PatchPickerArgs,
    opts?: { prompts?: PromptOverride }
): Promise<PatchPickerResult> {
    const blocks = parsePatchBlocks(args.patch);

    if (blocks.length === 0) {
        return { kept: "", droppedCount: 0 };
    }

    const clack = opts?.prompts ?? (await import("@clack/prompts"));
    const { select, note } = clack;
    // Override path (tests) returns plain strings; only clack's real select() emits the cancel
    // symbol on Ctrl-C, so the isCancel lookup is only needed for the real prompts module.
    const isCancel = "isCancel" in clack ? (clack as { isCancel: (v: unknown) => boolean }).isCancel : () => false;
    const keptBlocks: string[] = [];
    let dropped = 0;

    for (const block of blocks) {
        const surviving: string[] = [];

        for (const hunk of block.hunks) {
            note(hunk.body, `${block.filePath}: ${hunk.headerLine}`);

            const sel = await select({
                message: "Include this hunk?",
                options: [
                    { value: "y", label: "yes — include" },
                    { value: "n", label: "no — skip" },
                    { value: "q", label: "quit picker (keep nothing remaining)" },
                ],
            });

            if (isCancel(sel) || sel === "q") {
                if (surviving.length > 0) {
                    keptBlocks.push(`${block.headerLines.join("\n")}\n${surviving.join("\n")}`);
                }

                log.debug({ kept: keptBlocks.length, dropped, cancelled: isCancel(sel) }, "patch picker: quit early");

                return {
                    kept: keptBlocks.length ? `${keptBlocks.join("\n")}\n` : "",
                    droppedCount: dropped,
                };
            }

            if (sel === "y") {
                surviving.push(`${hunk.headerLine}\n${hunk.body}`);
            } else {
                dropped++;
            }
        }

        if (surviving.length > 0) {
            keptBlocks.push(`${block.headerLines.join("\n")}\n${surviving.join("\n")}`);
        }
    }

    log.debug({ kept: keptBlocks.length, dropped }, "patch picker: all hunks reviewed");

    return {
        kept: keptBlocks.length ? `${keptBlocks.join("\n")}\n` : "",
        droppedCount: dropped,
    };
}

function parsePatchBlocks(patch: string): FileBlock[] {
    // Walk the patch line-by-line. Each `diff --git` line starts a new file block.
    // Within a block, header lines accumulate until the first `@@` hunk header is seen.
    // Each `@@` starts a new hunk; its body is all lines until the next `@@` or next `diff --git`.
    const blocks: FileBlock[] = [];
    let current: FileBlock | null = null;
    let currentHunkHeader: string | null = null;
    let currentHunkBodyLines: string[] = [];
    let inHeader = true;

    const flushHunk = () => {
        if (current && currentHunkHeader !== null) {
            current.hunks.push({
                headerLine: currentHunkHeader,
                body: currentHunkBodyLines.join("\n"),
            });
        }

        currentHunkHeader = null;
        currentHunkBodyLines = [];
    };

    for (const line of patch.split("\n")) {
        if (line.startsWith("diff --git ")) {
            flushHunk();

            if (current) {
                blocks.push(current);
            }

            // Extract the destination file path from `diff --git a/<x> b/<y>` — take the `b/` side.
            const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
            current = { filePath: m?.[1] ?? "", headerLines: [line], hunks: [] };
            inHeader = true;
            continue;
        }

        if (!current) {
            continue;
        }

        if (line.startsWith("@@ ")) {
            flushHunk();
            currentHunkHeader = line;
            inHeader = false;
            continue;
        }

        if (inHeader) {
            current.headerLines.push(line);
        } else if (currentHunkHeader !== null) {
            currentHunkBodyLines.push(line);
        }
    }

    flushHunk();

    if (current) {
        blocks.push(current);
    }

    return blocks;
}
