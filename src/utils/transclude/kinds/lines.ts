import { defineTransclusion, formatLineRange, TransclusionError } from "../registry";
import { caption, codeBlock, languageFor, provenanceMeta, readSource, sourceIdentity, splitLines } from "./shared";

/** mdBook anchors: `ANCHOR: name` opens a region, `ANCHOR_END: name` closes it; marker lines are dropped. */
export function anchorRegion(lines: string[], anchor: string): { start: number; end: number; body: string[] } | null {
    const open = new RegExp(`ANCHOR:\\s*${escapeRegExp(anchor)}\\b`);
    const close = new RegExp(`ANCHOR_END:\\s*${escapeRegExp(anchor)}\\b`);
    const first = lines.findIndex((line) => open.test(line));

    if (first === -1) {
        return null;
    }

    const last = lines.findIndex((line, index) => index > first && close.test(line));
    const end = last === -1 ? lines.length : last;
    const body = lines.slice(first + 1, end).filter((line) => !/ANCHOR(?:_END)?:\s*[\w-]+/.test(line));
    return { start: first + 2, end, body };
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const linesTransclusion = defineTransclusion({
    name: "lines",
    description:
        "A line range (or an mdBook ANCHOR region) of a file. With commit= the lines come from that commit; " +
        "without it from the working tree, and the HEAD sha plus a dirty flag are recorded.",
    params: [
        {
            name: "path",
            type: "path",
            required: true,
            description: "The file; relative paths resolve against the cwd.",
        },
        { name: "range", type: "range", description: "Lines: 10-40, 10, 10- (to the end) or -40 (from the start)." },
        {
            name: "anchor",
            type: "string",
            description: "An mdBook region name: the lines between ANCHOR: x and ANCHOR_END: x.",
        },
        { name: "commit", type: "string", description: "Read the file at this commit (sha, branch or tag)." },
    ],
    requireOneOf: [["range", "anchor"]],
    examples: [
        '{{lines path="src/question/lib/decisions/store.ts" range="612-633"}}',
        '{{lines path="src/a.ts" range="10-40" commit="0942b47bc"}}',
        "{{#include src/a.ts:10:40}}",
    ],
    action: "substitute",
    async resolve(params, ctx) {
        const path = params.string("path");
        const commit = params.optionalString("commit");
        const source = await readSource({ path, commit, ctx });
        const lines = splitLines(source.text);
        const anchor = params.optionalString("anchor");

        if (anchor) {
            const region = anchorRegion(lines, anchor);

            if (!region) {
                throw new TransclusionError(`anchor "${anchor}" not found in ${path} (looked for "ANCHOR: ${anchor}")`);
            }

            return {
                markdown: codeBlock({
                    text: region.body.join("\n"),
                    lang: languageFor(path),
                    title: caption({ path, provenance: source.provenance, suffix: anchor }),
                }),
                meta: { ...provenanceMeta(source.provenance), anchor, lines: `${region.start}-${region.end}` },
                block: true,
                source: sourceIdentity({ path, provenance: source.provenance }),
            };
        }

        const range = params.range("range");

        if (range.start > lines.length) {
            throw new TransclusionError(
                `range ${formatLineRange(range)} starts past the end of ${path} (${lines.length} lines)`
            );
        }

        const end = Math.min(range.end ?? lines.length, lines.length);
        const shown = `${range.start}-${end}`;
        return {
            markdown: codeBlock({
                text: lines.slice(range.start - 1, end).join("\n"),
                lang: languageFor(path),
                title: caption({ path, provenance: source.provenance, suffix: shown }),
            }),
            meta: {
                ...provenanceMeta(source.provenance),
                lines: shown,
                ...(range.end !== null && range.end > lines.length ? { clampedFrom: range.end } : {}),
            },
            block: true,
            source: sourceIdentity({ path, provenance: source.provenance }),
        };
    },
});
