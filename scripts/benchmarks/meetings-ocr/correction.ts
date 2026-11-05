#!/usr/bin/env bun
/**
 * Vision's language correction on and off, over the same 40 frames as `bench.ts` (every 13th JPEG of the meeting's
 * `frames/`), with a word-level diff of the two reads.
 *
 * The arms run in one Swift process (`vision-arms.swift`, built once into the scratch folder), interleaved per frame,
 * so both pay the same Vision warm-up. CPU is that process's user + system time over each request (getrusage).
 *
 * Word-level diff, per frame: the words of each read (split on whitespace, punctuation kept inside a word), compared
 * as multisets. Reported:
 *   - words per arm, and the share of the "on" words the "off" read lacks (lost) and the share it adds (gained);
 *   - Czech words (holding a letter with a Czech diacritic) per arm: correction is tuned for the recognition
 *     language (en-US), so it may "fix" Czech words into English ones;
 *   - code-like tokens (a dot, slash, underscore, hyphen between letters, a digit next to a letter, or camelCase:
 *     file names, branches, ids) per arm: correction may break them;
 *   - dictionary words: of the plain words of 3+ letters (no digit, no inner capital), the share the macOS spell
 *     checker accepts in Czech or English, per arm and among the words only that arm read: the arm whose
 *     own words the dictionary accepts more often read the screen better there;
 *   - examples of words only one arm has.
 *
 * Usage: bun scripts/benchmarks/meetings-ocr/correction.ts [--meeting <folder>] [--scratch <dir>] [--languages en-US]
 *        [--frames 40] [--reads <reads-*.jsonl of an earlier run, to score again without OCR>] [--json]
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";
import { macos } from "@genesiscz/utils/transcribe/languages/spell/macos";
import { z } from "zod";
import { median } from "../fs/shared";

const DEFAULT_MEETING = genesisToolsDir("meetings", "2026-11-04_16-32-meeting");
const DEFAULT_SCRATCH = join(tmpdir(), "meetings-ocr-bench", "correction");
const EVERY_NTH = 13;
const CZECH = /[áčďéěíňóřšťúůýž]/i;
const CODE_LIKE = /[a-z][._/\\-][a-z0-9]|[a-z]\d|\d[a-z]|[a-z][A-Z]/;

function flagValue(flag: string): string | undefined {
    const at = process.argv.indexOf(flag);
    return at > 0 ? process.argv[at + 1] : undefined;
}

const rowSchema = z.object({
    path: z.string(),
    arm: z.enum(["on", "off"]),
    cpuMs: z.coerce.number(),
    wallMs: z.coerce.number(),
    text: z.string(),
});
type Row = z.infer<typeof rowSchema>;

export function wordsOf(text: string): string[] {
    return text
        .split(/\s+/)
        .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
        .filter((word) => word.length > 0);
}

/** The words of `a` that `b` lacks, as a multiset difference. */
export function missingWords(a: string[], b: string[]): string[] {
    const left = new Map<string, number>();

    for (const word of b) {
        left.set(word, (left.get(word) ?? 0) + 1);
    }

    const missing: string[] = [];

    for (const word of a) {
        const have = left.get(word) ?? 0;

        if (have > 0) {
            left.set(word, have - 1);
        } else {
            missing.push(word);
        }
    }

    return missing;
}

async function buildArms(scratch: string): Promise<string> {
    const source = join(moduleDir(import.meta), "vision-arms.swift");
    const binary = join(scratch, "vision-arms");

    if (existsSync(binary) && statSync(binary).mtimeMs >= statSync(source).mtimeMs) {
        return binary;
    }

    const proc = Bun.spawn(["swiftc", "-O", source, "-o", binary], { stdout: "inherit", stderr: "inherit" });

    if ((await proc.exited) !== 0) {
        throw new Error("swiftc failed for vision-arms.swift");
    }

    return binary;
}

function pickFrames(meeting: string, scratch: string, count: number): string[] {
    const source = join(meeting, "frames");
    const dir = join(scratch, "frames");
    mkdirSync(dir, { recursive: true });
    return readdirSync(source)
        .filter((name) => name.endsWith(".jpg"))
        .sort()
        .filter((_, index) => index % EVERY_NTH === 0)
        .slice(0, count)
        .map((name) => {
            const path = join(dir, name);

            copyFileSync(join(source, name), path);

            return path;
        });
}

async function main(): Promise<void> {
    const meeting = flagValue("--meeting") ?? DEFAULT_MEETING;
    const scratch = flagValue("--scratch") ?? DEFAULT_SCRATCH;
    const languages = flagValue("--languages") ?? "en-US";
    mkdirSync(scratch, { recursive: true });
    const frames = pickFrames(meeting, scratch, Number(flagValue("--frames") ?? 40));
    const cached = flagValue("--reads");
    let stdout: string;

    if (cached) {
        stdout = readFileSync(cached, "utf8");
    } else {
        const binary = await buildArms(scratch);
        const proc = Bun.spawn([binary, languages, ...frames], { stdout: "pipe", stderr: "inherit" });
        const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

        if (exitCode !== 0) {
            throw new Error(`vision-arms exited ${exitCode}`);
        }

        stdout = text;
    }

    const rows: Row[] = stdout
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => rowSchema.parse(SafeJSON.parse(line, { strict: true })));
    if (!cached) {
        writeFileSync(join(scratch, `reads-${languages}.jsonl`), stdout);
    }
    const byPath = new Map<string, Partial<Record<"on" | "off", Row>>>();

    for (const row of rows) {
        byPath.set(row.path, { ...byPath.get(row.path), [row.arm]: row });
    }

    const spellCs = await macos.open("cs");
    const spellEn = await macos.open("en");
    const plain = (words: string[]) => words.filter((word) => /^\p{L}{3,}$/u.test(word) && !/.\p{Lu}/u.test(word));
    const known = (words: string[]) => {
        const candidates = plain(words);
        const cs = spellCs.accepted(candidates);
        const en = spellEn.accepted(candidates);
        return { plain: candidates.length, known: candidates.filter((word) => cs.has(word) || en.has(word)).length };
    };
    const dictionary = {
        onPlain: 0,
        onKnown: 0,
        offPlain: 0,
        offKnown: 0,
        lostPlain: 0,
        lostKnown: 0,
        gainedPlain: 0,
        gainedKnown: 0,
    };
    const totals = { onWords: 0, offWords: 0, lost: 0, gained: 0, czechOn: 0, czechOff: 0, codeOn: 0, codeOff: 0 };
    const lostExamples = new Map<string, number>();
    const gainedExamples = new Map<string, number>();

    for (const { on, off } of byPath.values()) {
        if (!on || !off) {
            continue;
        }

        const a = wordsOf(on.text);
        const b = wordsOf(off.text);
        const lost = missingWords(a, b);
        const gained = missingWords(b, a);
        totals.onWords += a.length;
        totals.offWords += b.length;
        totals.lost += lost.length;
        totals.gained += gained.length;
        totals.czechOn += a.filter((word) => CZECH.test(word)).length;
        totals.czechOff += b.filter((word) => CZECH.test(word)).length;
        totals.codeOn += a.filter((word) => CODE_LIKE.test(word)).length;
        totals.codeOff += b.filter((word) => CODE_LIKE.test(word)).length;

        const scored = { on: known(a), off: known(b), lost: known(lost), gained: known(gained) };
        dictionary.onPlain += scored.on.plain;
        dictionary.onKnown += scored.on.known;
        dictionary.offPlain += scored.off.plain;
        dictionary.offKnown += scored.off.known;
        dictionary.lostPlain += scored.lost.plain;
        dictionary.lostKnown += scored.lost.known;
        dictionary.gainedPlain += scored.gained.plain;
        dictionary.gainedKnown += scored.gained.known;

        for (const word of lost) {
            lostExamples.set(word, (lostExamples.get(word) ?? 0) + 1);
        }

        for (const word of gained) {
            gainedExamples.set(word, (gainedExamples.get(word) ?? 0) + 1);
        }
    }

    const arm = (name: "on" | "off") => {
        const of = rows.filter((row) => row.arm === name);
        return {
            cpuMsMedian: median(of.map((row) => row.cpuMs)),
            wallMsMedian: Math.round(median(of.map((row) => row.wallMs))),
            cpuMsTotal: Math.round(of.reduce((sum, row) => sum + row.cpuMs, 0)),
            chars: of.reduce((sum, row) => sum + row.text.length, 0),
        };
    };
    const top = (map: Map<string, number>) =>
        [...map]
            .sort((x, y) => y[1] - x[1])
            .slice(0, 25)
            .map(([word, count]) => `${word}×${count}`);
    const pct = (part: number, whole: number) => Math.round((part / Math.max(1, whole)) * 1000) / 10;
    const result = {
        frames: byPath.size,
        languages,
        on: arm("on"),
        off: arm("off"),
        words: { ...totals, lostPct: pct(totals.lost, totals.onWords), gainedPct: pct(totals.gained, totals.onWords) },
        dictionaryKnownPct: {
            on: pct(dictionary.onKnown, dictionary.onPlain),
            off: pct(dictionary.offKnown, dictionary.offPlain),
            onlyWithCorrection: pct(dictionary.lostKnown, dictionary.lostPlain),
            onlyWithoutCorrection: pct(dictionary.gainedKnown, dictionary.gainedPlain),
            plainWords: dictionary,
        },
        czechWordsChangePct: pct(totals.czechOff - totals.czechOn, totals.czechOn),
        codeTokensChangePct: pct(totals.codeOff - totals.codeOn, totals.codeOn),
        onlyWithCorrection: top(lostExamples),
        onlyWithoutCorrection: top(gainedExamples),
    };

    spellCs.dispose();
    spellEn.dispose();

    if (process.argv.includes("--json")) {
        out.result(result);
        return;
    }

    out.println(SafeJSON.stringify(result, null, 2));
}

if (import.meta.main) {
    await main();
}
