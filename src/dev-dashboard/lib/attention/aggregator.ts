import type { AttentionItem, BuildAttentionInput } from "@app/dev-dashboard/lib/attention/types";

/** Foreground commands we treat as "an AI agent is running here" (extend as new CLIs land). */
export const AGENT_COMMANDS = new Set(["claude", "cursor", "codex", "aider"]);

export function isAgentCommand(command: string | undefined): command is string {
    if (!command) {
        return false;
    }

    return AGENT_COMMANDS.has(command.trim());
}

/** Local midnight (epoch ms) for the day containing `now`. */
function startOfDay(now: number): number {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);

    return d.getTime();
}

/** Tiny path basename — kept inline so this lib never depends on node:path. */
function basename(path: string): string {
    const parts = path.split("/").filter((p) => p.length > 0);

    return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** Pure join over the QA read-model + live ttyd sessions into one attention queue.
 *  No I/O; `now` is injected for deterministic tests. */
export function buildAttentionItems({
    qaEntries,
    ttydSessions,
    now = Date.now(),
}: BuildAttentionInput): AttentionItem[] {
    const dayStart = startOfDay(now);
    const items: AttentionItem[] = [];

    for (const row of qaEntries) {
        if (row.tag !== "action") {
            continue;
        }

        if (row.readAt != null) {
            continue;
        }

        if (row.ts < dayStart) {
            continue;
        }

        items.push({
            id: `qa:${row.id}`,
            kind: "agent-question",
            title: row.question,
            subtitle: row.project || row.agentLabel || "—",
            ts: row.ts,
            deepLink: { kind: "qa", qaId: row.id },
        });
    }

    for (const session of ttydSessions) {
        if (!isAgentCommand(session.lastCommand)) {
            continue;
        }

        const title = session.name && session.name.trim().length > 0 ? session.name : session.lastCommand;
        const startedMs = Date.parse(session.startedAt);
        const ts = Number.isNaN(startedMs) ? now : startedMs;

        items.push({
            id: `ttyd:${session.id}`,
            kind: "agent-session",
            title,
            subtitle: `${session.lastCommand} · ${basename(session.cwd)}`,
            ts,
            deepLink: { kind: "terminal", ttydTabId: session.id },
        });
    }

    // Newest-first; stable tie-break keeps QA ("answer me") above terminal items.
    return items.sort((a, b) => {
        if (b.ts !== a.ts) {
            return b.ts - a.ts;
        }

        const rank = (kind: AttentionItem["kind"]) => (kind === "agent-question" ? 0 : 1);

        return rank(a.kind) - rank(b.kind);
    });
}
