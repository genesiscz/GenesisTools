import { type ActiveClaudeSession, isHelperChild, listActiveClaudeSessions } from "@app/claude/lib/active-sessions";
import { suggestCommand } from "@genesiscz/utils/cli";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { collapsePath } from "@genesiscz/utils/paths";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

interface WhoOptions {
    json?: boolean;
    all?: boolean;
}

function accountCell(session: ActiveClaudeSession): string {
    if (session.proxyTarget) {
        return pc.cyan(`proxy:${session.proxyTarget}`);
    }

    if (session.account) {
        return pc.yellow(session.account);
    }

    return pc.dim("keychain?");
}

function sessionCell(session: ActiveClaudeSession): string {
    if (!session.sessionId) {
        return session.sessionCandidates > 1 ? pc.dim(`? (${session.sessionCandidates} in cwd)`) : pc.dim("—");
    }

    const short = pc.white(session.sessionId.slice(0, 8));
    // A guessed id must not look like a proven one: `focus` acts on it.
    const mark = session.sessionSource === "cwd-unique" ? pc.yellow("~") : "";
    // Two panes on one session both write to one transcript — say so on both rows.
    const dup = session.sessionInstances > 1 ? pc.magenta(` ×${session.sessionInstances}`) : "";

    return `${mark}${short}${dup}`;
}

function surfaceCell(session: ActiveClaudeSession): string {
    if (session.surfaceRef) {
        return pc.cyan(session.surfaceRef);
    }

    return session.tty === "??" ? pc.dim("—") : pc.dim(session.tty);
}

function nameCell(session: ActiveClaudeSession): string {
    if (session.sessionTitle) {
        return truncateDisplay(session.sessionTitle, 30);
    }

    return pc.dim(truncateDisplay(session.cwd ? collapsePath(session.cwd) : "", 30));
}

function startedCell(session: ActiveClaudeSession): string {
    if (!session.startedAt) {
        return pc.dim("—");
    }

    return formatRelativeTime(new Date(session.startedAt), { compact: true });
}

function sortKey(session: ActiveClaudeSession): string {
    return `${session.account ?? session.proxyTarget ?? "~keychain"}\0${session.startedAt ?? 0}`;
}

/** `@18:44:48`, the same clock the statusline prints for the last turn. */
function lastTurnCell(session: ActiveClaudeSession): string {
    if (session.lastActivityAt === null) {
        return pc.dim("—");
    }

    const stamp = `@${new Date(session.lastActivityAt).toLocaleTimeString("en-GB", { hour12: false })}`;
    const idleMin = (Date.now() - session.lastActivityAt) / 60_000;

    if (idleMin > 60) {
        return pc.dim(stamp);
    }

    return idleMin > 10 ? pc.yellow(stamp) : pc.green(stamp);
}

function renderTable(sessions: ActiveClaudeSession[]): void {
    renderCliHeader("Active Claude sessions", "live processes and the account each one bills");

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

    for (const session of sessions) {
        table.push([
            accountCell(session),
            String(session.pid),
            session.kind === "tui" ? "tui" : pc.dim(session.kind),
            sessionCell(session),
            nameCell(session),
            surfaceCell(session),
            lastTurnCell(session),
            startedCell(session),
            session.tty === "??" ? pc.dim("—") : session.tty,
            session.lastUserMessage ? pc.white(truncateDisplay(session.lastUserMessage, 38)) : pc.dim("—"),
        ]);
    }

    out.println(table.toString());

    const counts = new Map<string, number>();

    for (const session of sessions) {
        const key = session.proxyTarget ? `proxy:${session.proxyTarget}` : (session.account ?? "keychain?");
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const duplicates = [
        ...new Set(sessions.filter((s) => s.sessionInstances > 1 && s.sessionId).map((s) => s.sessionId as string)),
    ];
    const summary = [...counts.entries()].map(([name, count]) => `${name} ${count}`).join(" · ");
    out.println(pc.dim(`  ${sessions.length} process${sessions.length === 1 ? "" : "es"}  ·  ${summary}`));
    for (const sessionId of duplicates) {
        const rows = sessions.filter((s) => s.sessionId === sessionId);
        const where = rows.map((s) => s.surfaceRef ?? s.tty).join(", ");
        out.println(
            pc.magenta(`  ⚠ ${sessionId.slice(0, 8)} is open ${rows.length}× (${where}) — both write one transcript.`)
        );
    }

    out.println(
        pc.dim(
            `  Jump to one: ${pc.cyan(suggestCommand("tools claude", { replaceCommand: ["cmux", "focus", "<session>"] }))}` +
                `${duplicates.length > 0 ? pc.dim(" (a twice-open session lists both panes to pick from)") : ""}`
        )
    );
    out.println(pc.dim(`  ${pc.yellow("~")} = id inferred from the working directory, not proven.`));
}

export function registerWhoCommand(program: Command): void {
    program
        .command("who")
        .alias("active")
        .description(
            "List live Claude Code processes with the account each one runs as " +
                "(read from TOOLS_CLAUDE_ACCOUNT in the process env; 'keychain?' = launched outside tools claude run)"
        )
        .option("--json", "Machine-readable output")
        .option(
            "--all",
            "Include helper processes: `tools claude mcp` servers (any tty) and SDK launchers sharing a TUI's tty"
        )
        .action(async (opts: WhoOptions) => {
            const all = await listActiveClaudeSessions();
            const sessions = (opts.all ? all : all.filter((s) => !isHelperChild(s, all))).sort((a, b) =>
                sortKey(a).localeCompare(sortKey(b))
            );
            const hidden = all.length - sessions.length;

            if (opts.json) {
                out.result({ sessions });
                return;
            }

            if (sessions.length === 0) {
                out.println(pc.dim("No live claude processes."));
                return;
            }

            renderTable(sessions);

            if (hidden > 0) {
                out.println(
                    pc.dim(
                        `  ${hidden} helper process${hidden === 1 ? "" : "es"} (mcp servers, launchers) hidden — show with --all.`
                    )
                );
            }
        });
}
