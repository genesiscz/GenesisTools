import { existsSync, statSync } from "node:fs";
import { defineTransclusion, TransclusionError } from "../registry";
import { caption, codeBlock, languageFor, sourceIdentity, worktreeProvenance } from "./shared";

/** Only the end of the file is read, so a multi-gigabyte log costs the same as a small one. */
const TAIL_WINDOW_BYTES = 1024 * 1024;
const MAX_TAIL_LINES = 1000;

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
        const path = params.string("path");
        const n = params.int("n");

        if (n < 1 || n > MAX_TAIL_LINES) {
            throw new TransclusionError(`param "n" of tail expects 1-${MAX_TAIL_LINES}, got ${n}`);
        }

        if (!existsSync(path) || statSync(path).isDirectory()) {
            throw new TransclusionError(`file not found: ${path}`);
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
        const complete = size > TAIL_WINDOW_BYTES ? lines.slice(1) : lines;
        const shown = complete.slice(-n);
        const provenance = await worktreeProvenance(path, ctx);

        return {
            markdown: codeBlock({
                text: shown.join("\n"),
                lang: languageFor(path) || "text",
                title: `${caption({ path, provenance })}, last ${shown.length} lines`,
            }),
            meta: { ...provenance, bytes: size, lines: shown.length },
            block: true,
            source: sourceIdentity({ path, provenance }),
            ...(size <= TAIL_WINDOW_BYTES
                ? { shown: { shown: shown.length, total: complete.length, unit: "lines" } }
                : {}),
        };
    },
});
