/**
 * Which guard is rejecting the tightened bullets?
 *
 * The repaired prompt rewrote only 6 of 44 oversized bullets. The stage logs that a
 * replacement was rejected but not WHICH predicate said no, and guessing has been
 * wrong three times in this stage already. This runs one real batch and prints every
 * predicate's verdict per bullet.
 *
 * Usage: bun scripts/learn-from-fable/probe-tighten-guards.ts <spec.md> [model]
 */
import { readFileSync } from "node:fs";
import { createRunner } from "@app/learn-from-fable/lib/runners";
import { buildTightenUser, parseTightenReply, SPEC_TIGHTEN_SYSTEM } from "@app/learn-from-fable/lib/stages/spec";

const CAP = 420;
const [path, model = "martin/grok/grok-4.5"] = process.argv.slice(2);
const oversized = readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => /^\s*[-*]\s/.test(line) && line.length > CAP)
    .slice(0, 6);

const reply = await createRunner({ model }).call({
    system: SPEC_TIGHTEN_SYSTEM,
    user: buildTightenUser(oversized),
    maxTokens: 8000,
    timeoutMs: 600_000,
    firstOutputMs: 300_000,
    label: "probe-tighten",
});

const parsed = parseTightenReply(reply.text);
for (const [n, bullets] of parsed) {
    const original = oversized[n - 1];
    if (!original) {
        process.stdout.write(`#${n}: no such input bullet\n`);
        continue;
    }

    const joined = bullets.join(" ");
    const cites = [...original.matchAll(/\(([0-9a-f]{8})\)/g)].map((m) => m[1]);
    const maxPieces = Math.max(2, Math.ceil(original.length / CAP) + 1);
    process.stdout.write(
        `#${n} orig=${original.length} pieces=${bullets.length}/${maxPieces} joined=${joined.length} ` +
            `ratio=${(joined.length / original.length).toFixed(2)} ` +
            `citations=${cites.every((c) => joined.includes(c)) ? "kept" : "LOST"} ` +
            `longest=${Math.max(0, ...bullets.map((b) => b.length))}\n`
    );
}

process.exit(0);
