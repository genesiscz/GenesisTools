/**
 * Replay the tightening guards against replies the proxy already captured.
 *
 * The live probe kept stalling behind a concurrent merge run, and every reply is
 * already on disk in the proxy transcripts — so score the guards offline instead of
 * paying for the same calls twice. Prints, per bullet, which predicate said no.
 *
 * Usage: bun scripts/learn-from-fable/replay-tighten-guards.ts <transcript.jsonl>
 */
import { readFileSync } from "node:fs";
import { parseTightenReply } from "@app/learn-from-fable/lib/stages/spec";
import { SafeJSON } from "@genesiscz/utils/json";

const CAP = 420;
const path = process.argv[2];
if (!path) {
    process.stdout.write("usage: bun scripts/learn-from-fable/replay-tighten-guards.ts <transcript.jsonl>\n");
    process.exit(1);
}

interface TranscriptEntry {
    type?: string;
    label?: string;
    message?: { content?: unknown };
}

function textOf(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part === "object" && part && "text" in part ? String(part.text) : ""))
            .join("");
    }

    return "";
}

/** Pair each tighten request with the reply that followed it. */
const exchanges: { input: string[]; reply: string }[] = [];
let pending: string[] | undefined;

for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) {
        continue;
    }

    let entry: TranscriptEntry;
    try {
        entry = SafeJSON.parse(line, { strict: true }) as TranscriptEntry;
    } catch {
        continue;
    }

    const text = textOf(entry.message?.content);
    if (!text) {
        continue;
    }

    if (text.startsWith("### 1 (")) {
        // the request: "### n (len chars)" blocks, each followed by the bullet
        pending = text
            .split("\n")
            .filter((l) => /^\s*[-*]\s/.test(l))
            .map((l) => l.trimEnd());
        continue;
    }

    if (pending && text.includes("###")) {
        exchanges.push({ input: pending, reply: text });
        pending = undefined;
    }
}

let accepted = 0;
const reasons: Record<string, number> = {};
for (const { input, reply } of exchanges) {
    for (const [n, bullets] of parseTightenReply(reply)) {
        const original = input[n - 1];
        if (!original) {
            continue;
        }

        const joined = bullets.join(" ");
        const cites = [...original.matchAll(/\(([0-9a-f]{8})\)/g)].map((m) => m[1]);
        const maxPieces = Math.max(2, Math.ceil(original.length / CAP) + 1);
        const verdicts = [
            bullets.length ? "" : "empty",
            cites.every((c) => joined.includes(c)) ? "" : "lost-citation",
            joined.length >= original.length * 0.6 ? "" : "too-short",
            joined.length <= original.length * 1.2 ? "" : "inflated",
            bullets.length <= maxPieces ? "" : "too-many-pieces",
            bullets.every((b) => b.length <= CAP) ? "" : "still-over-cap",
        ].filter(Boolean);

        if (!verdicts.length) {
            accepted++;
        }

        for (const v of verdicts) {
            reasons[v] = (reasons[v] ?? 0) + 1;
        }

        process.stdout.write(
            `orig=${String(original.length).padStart(5)} pieces=${bullets.length}/${maxPieces} ` +
                `joined=${String(joined.length).padStart(5)} ratio=${(joined.length / original.length).toFixed(2)} ` +
                `${verdicts.length ? `REJECT ${verdicts.join(",")}` : "ok"}\n`
        );
    }
}

process.stdout.write(`\nexchanges ${exchanges.length}  accepted ${accepted}  rejects ${SafeJSON.stringify(reasons)}\n`);
process.exit(0);
