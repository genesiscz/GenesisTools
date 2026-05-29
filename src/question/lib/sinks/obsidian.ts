import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveVaultRoot } from "@app/utils/obsidian/config";
import type { QuestionConfig } from "../config";
import type { QaEntry } from "../types";
import { registerSink, type Sink, SinkError } from "./registry-exports";

function dateOf(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderEntry(e: QaEntry): string {
    const time = new Date(e.ts).toISOString().slice(11, 16);
    const refs = e.refs.length ? `\n\n_refs:_ ${e.refs.map((r) => `${r.type}:${r.value}`).join(" · ")}` : "";
    // One assembled multi-line string → single appendFileSync (atomic enough;
    // different {project}/{date} files rarely collide across 8 agents).
    const commit = e.commitSha ? `${e.commitSha}${e.commitMessage ? ` — ${e.commitMessage}` : ""}` : "-";
    const agent = e.agent !== "unknown" ? ` · ${e.agent}` : "";
    const title = e.sessionTitle ? ` · ${e.sessionTitle}` : "";
    return `\n## ${time} · ${e.question}\n- [ ] reviewed · \`${e.tag}\` · ${e.branch ?? "-"}@${commit}${agent} · session ${e.sessionId}${title}\n\n${e.answerMd}${refs}\n\n---\n`;
}

/** Standalone so tests can inject a vault path; the Sink wraps this. */
export function emitObsidian(entry: QaEntry, config: QuestionConfig, vaultOverride?: string | null): void {
    const vault = vaultOverride !== undefined ? vaultOverride : resolveVaultRoot();
    if (!vault) {
        throw new SinkError(
            "Obsidian vault not found",
            "run: tools question config --obsidian-vault <path>  (or open your vault in Obsidian once)"
        );
    }

    const rel = config.obsidianPathTemplate
        .replaceAll("{project}", entry.project)
        .replaceAll("{date}", dateOf(entry.ts))
        .replaceAll("{branch}", entry.branch ?? "-")
        .replaceAll("{tag}", entry.tag)
        .replaceAll("{session}", entry.sessionId);
    const file = join(vault, rel);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, renderEntry(entry));
}

export const obsidianSink: Sink = {
    name: "obsidian",
    isEnabled: (c) => c.sinks.obsidian,
    emit: (entry, config) => emitObsidian(entry, config),
};

registerSink(obsidianSink);
