/**
 * Repair an already-written spec proposal: split its oversized bullets in place.
 *
 * The merge passes are graded on never losing anything, which is the pressure that
 * produces 1_600-character bullets. Rather than re-running 15 passes to fix shape,
 * this runs only the tightening step against an existing file, splicing replacements
 * back by line index so every other bullet stays byte-identical.
 *
 * Usage: bun scripts/learn-from-fable/tighten-spec.ts <in.md> <out.md> [model]
 */
import { existsSync, readFileSync } from "node:fs";
import { createRunner } from "@app/learn-from-fable/lib/runners";
import { tightenDraft } from "@app/learn-from-fable/lib/stages/spec";

const [input, output, model = "martin/grok/grok-4.5"] = process.argv.slice(2);
if (!input || !output) {
    process.stdout.write("usage: bun scripts/learn-from-fable/tighten-spec.ts <in.md> <out.md> [model]\n");
    process.exit(1);
}

if (existsSync(output)) {
    process.stdout.write(`refusing to overwrite ${output}\n`);
    process.exit(1);
}

const before = readFileSync(input, "utf-8");
const next = await tightenDraft(createRunner({ model }), before, {
    maxLines: 400,
    minConfidence: 0,
    firstOutputMs: 300_000,
});

if (!next) {
    process.stdout.write("tightening produced nothing usable — input left alone\n");
    process.exit(1);
}

await Bun.write(output, next.endsWith("\n") ? next : `${next}\n`);
const bullets = (md: string) => md.split("\n").filter((l) => /^\s*[-*]\s/.test(l)).length;
const over = (md: string) => md.split("\n").filter((l) => /^\s*[-*]\s/.test(l) && l.length > 420).length;
process.stdout.write(
    `${input}\n  bullets ${bullets(before)} -> ${bullets(next)}, over-cap ${over(before)} -> ${over(next)}\n${output}\n`
);
process.exit(0);
