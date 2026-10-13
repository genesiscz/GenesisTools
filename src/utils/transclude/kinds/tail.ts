import { existsSync, statSync } from "node:fs";
import { readLastLines } from "@genesiscz/utils/fs/read-lines";
import { defineTransclusion, TransclusionError } from "../registry";
import { caption, codeBlock, languageFor, sourceIdentity, worktreeProvenance } from "./shared";

/** Only the end of the file is read, so a multi-gigabyte log costs the same as a small one. */
const TAIL_WINDOW_BYTES = 1024 * 1024;
const MAX_TAIL_LINES = 1000;

/** The complete lines of the file's last megabyte; a `.zst` file's last megabyte of content (its last frames). */
async function tailWindow(path: string): Promise<{ complete: string[]; wholeFile: boolean }> {
    if (path.endsWith(".zst")) {
        const { lines, wholeFile } = readLastLines(path, { maxBytes: TAIL_WINDOW_BYTES });
        return { complete: lines, wholeFile };
    }

    const size = statSync(path).size;
    const window = await Bun.file(path)
        .slice(Math.max(0, size - TAIL_WINDOW_BYTES), size)
        .text();
    const lines = window.split("\n");

    if (lines[lines.length - 1] === "") {
        lines.pop();
    }

    // A window that starts mid-file starts mid-line; that first partial line is dropped.
    return { complete: size > TAIL_WINDOW_BYTES ? lines.slice(1) : lines, wholeFile: size <= TAIL_WINDOW_BYTES };
}

export const tailTransclusion = defineTransclusion({
    name: "tail",
    description: "The last n lines of a file (a log, a transcript). Reads only the final megabyte.",
    params: [
        {
            name: "path",
            type: "path",
            required: true,
            description: "The file; relative paths resolve against the cwd.",
        },
        { name: "n", type: "int", default: 50, description: `How many lines, at most ${MAX_TAIL_LINES}.` },
    ],
    examples: ['{{tail path="~/.genesis-tools/logs/2026-09-30.log" n=20}}'],
    action: "substitute",
    async resolve(params, ctx) {
        const asked = params.string("path");
        const n = params.int("n");

        if (n < 1 || n > MAX_TAIL_LINES) {
            throw new TransclusionError(`param "n" of tail expects 1-${MAX_TAIL_LINES}, got ${n}`);
        }

        // An older day log is stored as `<name>.zst` by the daily compression pass.
        const path = !existsSync(asked) && existsSync(`${asked}.zst`) ? `${asked}.zst` : asked;

        if (!existsSync(path) || statSync(path).isDirectory()) {
            throw new TransclusionError(`file not found: ${asked}`);
        }

        const { complete, wholeFile } = await tailWindow(path);
        const shown = complete.slice(-n);
        const provenance = await worktreeProvenance(path, ctx);

        return {
            markdown: codeBlock({
                text: shown.join("\n"),
                lang: languageFor(asked) || "text",
                title: `${caption({ path, provenance })}, last ${shown.length} lines`,
            }),
            meta: { ...provenance, bytes: statSync(path).size, lines: shown.length },
            block: true,
            source: sourceIdentity({ path, provenance }),
            ...(wholeFile ? { shown: { shown: shown.length, total: complete.length, unit: "lines" } } : {}),
        };
    },
});
