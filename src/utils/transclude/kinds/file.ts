import { defineTransclusion } from "../registry";
import { caption, codeBlock, languageFor, provenanceMeta, readSource, sourceIdentity, splitLines } from "./shared";

export const fileTransclusion = defineTransclusion({
    name: "file",
    description:
        "A whole file as a code block, cut after max lines with a note. With commit= it is read from that " +
        "commit; without it from the working tree, with the HEAD sha and a dirty flag recorded.",
    params: [
        {
            name: "path",
            type: "path",
            required: true,
            description: "The file; relative paths resolve against the cwd.",
        },
        { name: "commit", type: "string", description: "Read the file at this commit (sha, branch or tag)." },
        { name: "max", type: "int", default: 200, description: "The most lines to include." },
    ],
    examples: [
        '{{file path="bunfig.toml"}}',
        '{{file path="package.json" max=40 commit="HEAD~3"}}',
        "{{#include bunfig.toml}}",
    ],
    action: "substitute",
    async resolve(params, ctx) {
        const path = params.string("path");
        const source = await readSource({ path, commit: params.optionalString("commit"), ctx });
        const lines = splitLines(source.text);
        const max = Math.max(1, params.int("max"));
        const shown = lines.slice(0, max);
        return {
            markdown: codeBlock({
                text: shown.join("\n"),
                lang: languageFor(path),
                title: caption({ path, provenance: source.provenance }),
            }),
            meta: { ...provenanceMeta(source.provenance), lines: lines.length, shown: shown.length },
            block: true,
            source: sourceIdentity({ path, provenance: source.provenance }),
            ...(shown.length < lines.length
                ? { shown: { shown: shown.length, total: lines.length, unit: "lines" } }
                : {}),
        };
    },
});
