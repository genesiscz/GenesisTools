#!/usr/bin/env bun
/**
 * Everything the judge reads for one worker round, in one file: the worker's claims (each reply item with its
 * verdict and the reply text it wants posted), the refusals and deferrals flagged, then the full diff with the test
 * files first (removed assertions are guilty until explained). Read it whole before the push (judging.md).
 *
 *   bun judge-pack.ts --wt <worktree> --range <a>..<b> --replies <json> [--out <file>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { flag } from "./run";

interface ReplyItem {
    ref?: string;
    verdict: string;
    where: string;
    title: string;
    context: string;
    howFixed?: string;
    reply: string;
    commits?: string[];
    confidence?: number;
}

const wt = flag("--wt") ?? ".";
const range = flag("--range") ?? "HEAD~1..HEAD";
const repliesPath = flag("--replies");
const out: string[] = [];
const git = (args: string[]) =>
    Bun.spawnSync(["git", "-C", wt, ...args], { stdout: "pipe", stderr: "pipe" }).stdout.toString();

if (repliesPath) {
    const r = SafeJSON.parse(readFileSync(repliesPath, "utf8"), { strict: true }) as {
        pr: number;
        round: number;
        model: string;
        intro: string;
        items: ReplyItem[];
    };
    out.push(`# Claims: PR #${r.pr} round ${r.round} by ${r.model}`, "", r.intro, "");
    const flagged: string[] = [];

    for (const i of r.items) {
        const refusal = i.verdict !== "fixed";
        out.push(
            `## ${i.ref ?? "(no thread)"} ${i.verdict} ${i.where}${refusal ? "  ⚠ REFUSAL/DEFERRAL: check it" : ""}`,
            `- title: ${i.title}`,
            `- context: ${i.context}`
        );

        if (i.howFixed) {
            out.push(`- howFixed: ${i.howFixed}`);
        }

        out.push(
            `- reply: ${i.reply}`,
            `- commits: ${(i.commits ?? []).join(", ") || "-"}  confidence ${i.confidence}`,
            ""
        );

        if (refusal) {
            flagged.push(`${i.ref ?? "-"} ${i.verdict} ${i.where}: ${i.title}`);
        }

        if (/follow.?up|later|separate PR|out of scope|future/i.test(`${i.reply} ${i.howFixed ?? ""}`)) {
            flagged.push(`${i.ref ?? "-"} mentions a deferral: ${i.where}`);
        }
    }

    out.push("# Refusals and deferrals to judge", ...(flagged.length ? flagged.map((x) => `- ${x}`) : ["- none"]), "");
}

out.push(
    `# Diff ${range}`,
    "",
    "```",
    git(["log", "--format=%h %s", range]),
    git(["diff", "--stat", range]),
    "```",
    ""
);
const files = git(["diff", "--name-only", range]).split("\n").filter(Boolean);
const tests = files.filter((f) => /(\.test\.tsx?|Tests?\.swift|__tests__)/.test(f));
const sources = files.filter((f) => !tests.includes(f));

for (const [title, group] of [
    ["Tests (look for weakened or deleted assertions)", tests],
    ["Sources", sources],
] as const) {
    out.push(`## ${title}`, "", "```diff");

    for (const f of group) {
        out.push(git(["diff", range, "--", f]));
    }

    out.push("```", "");
}

const text = out.join("\n");
const target = flag("--out");

if (target) {
    writeFileSync(target, text);
    console.log(`${target}: ${text.split("\n").length} lines`);
} else {
    process.stdout.write(text);
}
