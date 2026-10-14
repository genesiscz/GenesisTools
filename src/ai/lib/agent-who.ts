import {
    type ActiveAgentSession,
    type AgentWhoSource,
    listActiveAgentSessions,
    withoutHelpers,
} from "@genesiscz/utils/ai/active-sessions";
import { suggestCommand } from "@genesiscz/utils/cli";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { collapsePath } from "@genesiscz/utils/paths";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";

/**
 * The `who` table for one coding agent: its live processes, the account each one bills, the session each runs
 * and the cmux tab it shows in. One renderer for every agent; what differs per agent is its {@link AgentWhoSource},
 * declared beside that agent's code (its spec's `processScan`, Claude's `CLAUDE_WHO_SOURCE`). A DIAGNOSTIC: it
 * reads the process table, cmux and the transcripts, and touches no credential.
 */

export interface AgentWhoOptions extends AgentWhoSource {
    /** `tools codex`, for the hints. */
    tool: string;
    /** The account cell of a process launched outside `tools <agent> run`; default `native?`. */
    noAccountLabel?: string;
}

function accountCell(entry: ActiveAgentSession, noAccount: string): string {
    if (entry.proxyTarget) {
        return pc.cyan(`proxy:${entry.proxyTarget}`);
    }

    if (entry.account) {
        return pc.yellow(entry.account);
    }

    return pc.dim(noAccount);
}

function sessionCell(entry: ActiveAgentSession): string {
    if (!entry.sessionId) {
        return entry.sessionCandidates > 1 ? pc.dim(`? (${entry.sessionCandidates} in cwd)`) : pc.dim("—");
    }

    const short = pc.white(entry.sessionId.slice(0, 8));
    // A guessed id must not look like a proven one: `focus` acts on it.
    const mark = entry.sessionSource === "cwd-unique" ? pc.yellow("~") : "";
    // Two panes on one session both write to one transcript; say so on both rows.
    const dup = entry.sessionInstances > 1 ? pc.magenta(` ×${entry.sessionInstances}`) : "";

    return `${mark}${short}${dup}`;
}

function surfaceCell(entry: ActiveAgentSession): string {
    if (entry.surfaceRef) {
        return pc.cyan(entry.surfaceRef);
    }

    return entry.tty === "??" ? pc.dim("—") : pc.dim(entry.tty);
}

function nameCell(entry: ActiveAgentSession): string {
    if (entry.sessionTitle) {
        return truncateDisplay(entry.sessionTitle, 30);
    }

    return pc.dim(truncateDisplay(entry.cwd ? collapsePath(entry.cwd) : "", 30));
}

function startedCell(entry: ActiveAgentSession): string {
    if (!entry.startedAt) {
        return pc.dim("—");
    }

    return formatRelativeTime(new Date(entry.startedAt), { compact: true });
}

/** `@18:44:48`, the same clock the statusline prints for the last turn. */
function lastTurnCell(entry: ActiveAgentSession): string {
    if (entry.lastActivityAt === null) {
        return pc.dim("—");
    }

    const stamp = `@${new Date(entry.lastActivityAt).toLocaleTimeString("en-GB", { hour12: false })}`;
    const idleMin = (Date.now() - entry.lastActivityAt) / 60_000;

    if (idleMin > 60) {
        return pc.dim(stamp);
    }

    return idleMin > 10 ? pc.yellow(stamp) : pc.green(stamp);
}

function renderTable(entries: ActiveAgentSession[], options: AgentWhoOptions): void {
    const noAccount = options.noAccountLabel ?? "native?";
    renderCliHeader(`Active ${options.alias} sessions`, "live processes and the account each one bills");

    const table = createBoxTable([
        "ACCOUNT",
        "PID",
        "KIND",
        "SESSION",
        "NAME",
        "SURFACE",
        "LAST TURN",
        "STARTED",
        "TTY",
        "LAST MESSAGE",
    ]);

    for (const entry of entries) {
        table.push([
            accountCell(entry, noAccount),
            String(entry.pid),
            entry.kind === "tui" ? "tui" : pc.dim(entry.kind),
            sessionCell(entry),
            nameCell(entry),
            surfaceCell(entry),
            lastTurnCell(entry),
            startedCell(entry),
            entry.tty === "??" ? pc.dim("—") : entry.tty,
            entry.lastUserMessage ? pc.white(truncateDisplay(entry.lastUserMessage, 38)) : pc.dim("—"),
        ]);
    }

    out.println(table.toString());

    const counts = new Map<string, number>();

    for (const entry of entries) {
        const key = entry.proxyTarget ? `proxy:${entry.proxyTarget}` : (entry.account ?? noAccount);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const duplicates = [
        ...new Set(entries.filter((e) => e.sessionInstances > 1 && e.sessionId).map((e) => e.sessionId as string)),
    ];
    const summary = [...counts.entries()].map(([name, count]) => `${name} ${count}`).join(" · ");
    out.println(pc.dim(`  ${entries.length} process${entries.length === 1 ? "" : "es"}  ·  ${summary}`));

    for (const sessionId of duplicates) {
        const rows = entries.filter((e) => e.sessionId === sessionId);
        const where = rows.map((e) => e.surfaceRef ?? e.tty).join(", ");
        out.println(
            pc.magenta(`  ⚠ ${sessionId.slice(0, 8)} is open ${rows.length}× (${where}) — both write one transcript.`)
        );
    }

    out.println(
        pc.dim(
            `  Jump to one: ${pc.cyan(suggestCommand(options.tool, { replaceCommand: ["cmux", "focus", "<session>"] }))}` +
                `${duplicates.length > 0 ? pc.dim(" (a twice-open session lists both panes to pick from)") : ""}`
        )
    );
    out.println(pc.dim(`  ${pc.yellow("~")} = id inferred from the working directory, not proven.`));
}

function sortKey(entry: ActiveAgentSession): string {
    return `${entry.account ?? entry.proxyTarget ?? "~"}\0${entry.startedAt ?? 0}`;
}

/** The `who` output for one agent; `tools ai accounts who` calls it for Claude. */
export async function runAgentWho(options: AgentWhoOptions, flags: { json?: boolean; all?: boolean }): Promise<void> {
    const all = await listActiveAgentSessions(options);
    const entries = (flags.all ? all : withoutHelpers(options, all)).sort((a, b) =>
        sortKey(a).localeCompare(sortKey(b))
    );

    if (flags.json) {
        out.result({ sessions: entries });
        return;
    }

    if (entries.length === 0) {
        out.println(pc.dim(`No live ${options.alias} processes.`));
        return;
    }

    renderTable(entries, options);

    const hidden = all.length - entries.length;

    if (hidden > 0) {
        out.println(pc.dim(`  ${hidden} helper process${hidden === 1 ? "" : "es"} hidden — show with --all.`));
    }
}
