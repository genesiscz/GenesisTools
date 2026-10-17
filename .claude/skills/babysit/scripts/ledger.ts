#!/usr/bin/env bun
/**
 * The babysit run ledger: one JSONL event per line, appended as the run goes, rendered to Markdown on demand.
 * Everything a reader needs to audit a run sits in it: every prompt a worker got (spawn and steer, full text),
 * each worker turn's final message, the judge's verdict and findings, corrections, pushes and posts.
 * (Martin, 2026-10-14: "all the steers, the agent's final messages, the prompts / inputs / judge rounds".)
 *
 *   bun ledger.ts append --run <dir> --kind <kind> [--pr N] [--round N] [--worker name] [--model m]
 *                        [--text "…" | --file <path>] [--meta '{"k":"v"}'] [--at <ISO time>]
 *   bun ledger.ts render --run <dir> [--out <file.md>] [--pr N]
 *
 * Kinds: spawn, steer, turn (a worker turn ended: its final message), judge (verdict + findings), correction,
 * push, post, decision, incident, note. The ledger is `<run>/ledger.jsonl`; text is stored whole, the Markdown
 * folds long text into <details> so the page stays readable.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

export const LEDGER_KINDS = [
    "spawn",
    "steer",
    "turn",
    "judge",
    "correction",
    "push",
    "post",
    "decision",
    "incident",
    "note",
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export interface LedgerEvent {
    at: string;
    kind: LedgerKind;
    pr?: number;
    round?: number;
    worker?: string;
    model?: string;
    text?: string;
    meta?: Record<string, unknown>;
}

export function ledgerPath(run: string): string {
    return join(run, "ledger.jsonl");
}

export function appendEvent(run: string, event: Omit<LedgerEvent, "at"> & { at?: string }): LedgerEvent {
    mkdirSync(run, { recursive: true });
    const full: LedgerEvent = { at: event.at ?? new Date().toISOString(), ...event } as LedgerEvent;
    appendFileSync(ledgerPath(run), `${SafeJSON.stringify(full, { strict: true })}\n`);
    return full;
}

export function readEvents(run: string): LedgerEvent[] {
    const path = ledgerPath(run);

    if (!existsSync(path)) {
        return [];
    }

    const events: LedgerEvent[] = [];

    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) {
            continue;
        }

        try {
            events.push(SafeJSON.parse(line, { strict: true }) as LedgerEvent);
        } catch {
            events.push({ at: "", kind: "note", text: `(unreadable ledger line) ${line.slice(0, 200)}` });
        }
    }

    return events.sort((a, b) => a.at.localeCompare(b.at));
}

const LOCAL = new Intl.DateTimeFormat("cs-CZ", {
    timeZone: "Europe/Prague",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
});
const ICON: Record<LedgerKind, string> = {
    spawn: "🚀",
    steer: "➡️",
    turn: "🗣️",
    judge: "⚖️",
    correction: "🔧",
    push: "⬆️",
    post: "💬",
    decision: "❓",
    incident: "🛑",
    note: "📝",
};

function fold(text: string, summary: string): string[] {
    if (text.length <= 600 && text.split("\n").length <= 8) {
        return ["", text.trim(), ""];
    }

    return [
        "",
        `<details><summary>${summary} (${text.split("\n").length} lines)</summary>`,
        "",
        "````text",
        text.trim(),
        "````",
        "",
        "</details>",
        "",
    ];
}

export function renderMarkdown(events: LedgerEvent[], options: { title?: string; pr?: number } = {}): string {
    const shown = options.pr === undefined ? events : events.filter((e) => e.pr === options.pr || e.pr === undefined);
    const prs = [...new Set(shown.map((e) => e.pr).filter((p): p is number => p !== undefined))].sort((a, b) => a - b);
    const out: string[] = [`# ${options.title ?? "Babysit run ledger"}`, ""];

    out.push(
        "## Overview",
        "",
        "| PR | Rounds pushed | Last verdict | Steers | Worker turns |",
        "|---|---|---|---|---|"
    );
    for (const pr of prs) {
        const mine = shown.filter((e) => e.pr === pr);
        const pushes = mine.filter((e) => e.kind === "push").map((e) => `r${e.round ?? "?"}`);
        const lastJudge = [...mine].reverse().find((e) => e.kind === "judge");
        out.push(
            `| #${pr} | ${pushes.join(", ") || "-"} | ${String(lastJudge?.meta?.verdict ?? "-")} | ${mine.filter((e) => e.kind === "steer" || e.kind === "spawn").length} | ${mine.filter((e) => e.kind === "turn").length} |`
        );
    }

    out.push("");

    const general = shown.filter((e) => e.pr === undefined);
    if (general.length) {
        out.push("## Run-wide events", "");
        for (const e of general) {
            out.push(
                `- ${ICON[e.kind]} ${LOCAL.format(new Date(e.at))} **${e.kind}** ${e.text?.split("\n")[0]?.slice(0, 200) ?? ""}`
            );
        }

        out.push("");
    }

    for (const pr of prs) {
        out.push(`## PR #${pr}`, "");
        for (const e of shown.filter((x) => x.pr === pr)) {
            const who = [e.worker, e.model].filter(Boolean).join(", ");
            const head = `### ${ICON[e.kind]} ${LOCAL.format(new Date(e.at))} ${e.kind}${e.round !== undefined ? ` · round ${e.round}` : ""}${who ? ` · ${who}` : ""}`;
            out.push(head);
            if (e.meta && Object.keys(e.meta).length) {
                out.push(
                    "",
                    ...Object.entries(e.meta).map(
                        ([k, v]) => `- **${k}**: ${typeof v === "string" ? v : SafeJSON.stringify(v, { strict: true })}`
                    )
                );
            }

            if (e.text) {
                out.push(
                    ...fold(
                        e.text,
                        e.kind === "steer" || e.kind === "spawn"
                            ? "prompt"
                            : e.kind === "turn"
                              ? "worker's final message"
                              : "text"
                    )
                );
            } else {
                out.push("");
            }
        }
    }

    return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

if (import.meta.main) {
    const [verb, ...rest] = process.argv.slice(2);
    const arg = (n: string) => {
        const i = rest.indexOf(n);
        return i >= 0 ? rest[i + 1] : undefined;
    };
    const run = arg("--run");

    if (!run || (verb !== "append" && verb !== "render")) {
        console.error("usage: ledger.ts append|render --run <dir> …  (see the header)");
        process.exit(2);
    }

    if (verb === "append") {
        const kind = arg("--kind") as LedgerKind | undefined;

        if (!kind || !LEDGER_KINDS.includes(kind)) {
            console.error(`--kind must be one of: ${LEDGER_KINDS.join(", ")}`);
            process.exit(2);
        }

        const file = arg("--file");
        const meta = arg("--meta");
        const event = appendEvent(run, {
            kind,
            ...(arg("--at") ? { at: arg("--at") } : {}),
            ...(arg("--pr") ? { pr: Number(arg("--pr")) } : {}),
            ...(arg("--round") ? { round: Number(arg("--round")) } : {}),
            ...(arg("--worker") ? { worker: arg("--worker") } : {}),
            ...(arg("--model") ? { model: arg("--model") } : {}),
            ...(file ? { text: readFileSync(file, "utf8") } : arg("--text") ? { text: arg("--text") } : {}),
            ...(meta ? { meta: SafeJSON.parse(meta, { strict: true }) as Record<string, unknown> } : {}),
        });
        console.log(`ledger: ${event.kind}${event.pr ? ` #${event.pr}` : ""} at ${event.at}`);
    } else {
        const pr = arg("--pr");
        const md = renderMarkdown(readEvents(run), { ...(pr ? { pr: Number(pr) } : {}) });
        const target = arg("--out");

        if (target) {
            writeFileSync(target, md);
            console.log(`${target}: ${md.split("\n").length} lines`);
        } else {
            process.stdout.write(md);
        }
    }
}
