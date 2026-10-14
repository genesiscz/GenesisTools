import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isInteractive } from "@genesiscz/utils/cli";
import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { logger, out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { deriveRegistry } from "../lib/derived-registry";
import { runWithFriendlyErrors } from "../lib/errors";
import { FeedLogCursor, readFeed } from "../lib/feed";
import {
    type AgentNames,
    type BatchPosition,
    eventJsonLine,
    formatEventMonitor,
    learnAgentNames,
} from "../lib/format-monitor";
import { formatEventPretty } from "../lib/format-pretty";
import { onShutdown } from "../lib/lifecycle";
import { type FeedFormat, resolveFeedFormat } from "../lib/login-io";
import { agentsRoot, ensureSessionDir, sessionPaths } from "../lib/paths";
import { runStaleSweep } from "../lib/slot-lock";
import type { FeedEvent } from "../lib/types";

const RECENT_WINDOW_MS = 60 * 60 * 1000;
const WATCH_DEBOUNCE_MS = 0;

const log = logger.child({ component: "agents:listen" });

interface ListenOpts {
    session?: string;
    sessionName?: string;
    recentHour?: boolean;
    format?: string;
}

interface SessionSummary {
    session: string;
    mainName: string | null;
    agentCount: number;
    lastEventAgo: string;
    mtimeMs: number;
}

async function listSessions(): Promise<SessionSummary[]> {
    const root = agentsRoot();

    if (!existsSync(root)) {
        return [];
    }

    const entries = readdirSync(root);
    const out: SessionSummary[] = [];

    for (const entry of entries) {
        const dir = join(root, entry);

        try {
            const stat = statSync(dir);

            if (!stat.isDirectory()) {
                continue;
            }
        } catch (err) {
            log.debug({ err, dir }, "skipping unreadable agents session directory");
            continue;
        }

        const paths = sessionPaths(entry);

        if (!existsSync(paths.feedPath)) {
            continue;
        }

        const events = await readFeed(paths);
        const records = deriveRegistry(events);
        const main = records.find((r) => r.is_main);
        const mtime = statSync(paths.feedPath).mtimeMs;
        out.push({
            session: entry,
            mainName: main ? main.agent_name : null,
            agentCount: records.length,
            lastEventAgo: formatAgo(Date.now() - mtime),
            mtimeMs: mtime,
        });
    }

    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function formatAgo(ms: number): string {
    if (ms < 1000) {
        return "now";
    }

    if (ms < 60_000) {
        return `${Math.floor(ms / 1000)}s ago`;
    }

    if (ms < 3_600_000) {
        return `${Math.floor(ms / 60_000)}m ago`;
    }

    if (ms < 86_400_000) {
        return `${Math.floor(ms / 3_600_000)}h ago`;
    }

    return `${Math.floor(ms / 86_400_000)}d ago`;
}

async function pickSession(opts: ListenOpts): Promise<string | null> {
    if (opts.session) {
        return opts.session;
    }

    if (opts.sessionName) {
        const sessions = await listSessions();
        const found = sessions.find((s) => s.mainName === opts.sessionName);
        return found ? found.session : null;
    }

    const sessions = await listSessions();
    const filtered = opts.recentHour ? sessions.filter((s) => Date.now() - s.mtimeMs < RECENT_WINDOW_MS) : sessions;

    if (filtered.length === 0) {
        return null;
    }

    if (!isInteractive()) {
        if (filtered.length === 1 && filtered[0]) {
            return filtered[0].session;
        }

        out.log.warn(`multiple active sessions; pass --session <id> or --session-name <name>. Available:`);

        for (const s of filtered) {
            out.println(`  ${s.session}  ${s.mainName ?? "(no main)"}  ${s.agentCount} agents  ${s.lastEventAgo}`);
        }

        return null;
    }

    const { select } = await import("@genesiscz/utils/prompts/clack");
    const choices = filtered.map((s) => ({
        label: `${s.session.slice(0, 12)} — ${s.mainName ?? "(no main)"} — ${s.agentCount} agents — ${s.lastEventAgo}`,
        value: s.session,
    }));
    const picked = await select({ message: "Pick a session to follow:", options: choices });
    return typeof picked === "string" ? picked : null;
}

function nextListenerId(): string {
    return `obs_${randomBytes(3).toString("hex")}`;
}

function emitEvent({
    event,
    format,
    names,
    position,
}: {
    event: FeedEvent;
    format: FeedFormat;
    names: AgentNames;
    position: BatchPosition;
}): void {
    learnAgentNames(names, event);

    if (format === "json") {
        out.println(eventJsonLine(event));
        return;
    }

    if (format === "monitor") {
        out.println(formatEventMonitor(event, names, position));
        return;
    }

    out.println(formatEventPretty(event));
}

export async function runListen(opts: ListenOpts): Promise<void> {
    const format = resolveFeedFormat({
        format: opts.format,
        terminalDefault: "pretty",
        stdoutIsTTY: Boolean(process.stdout.isTTY),
    });
    const session = await pickSession(opts);

    if (!session) {
        out.log.error("no session selected; nothing to listen to");
        process.exit(1);
        return;
    }

    const paths = sessionPaths(session);
    ensureSessionDir(paths);
    await runStaleSweep(paths);

    const names: AgentNames = new Map();
    const listenerId = nextListenerId();
    let lastSeq = 0;

    const controller = new AbortController();

    onShutdown(() => {
        log.debug({ listenerId }, "listener detaching");
        controller.abort();
    });

    const initial = await readFeed(paths);

    for (const [index, event] of initial.entries()) {
        emitEvent({ event, format, names, position: { index: index + 1, total: initial.length } });

        if (event.seq > lastSeq) {
            lastSeq = event.seq;
        }
    }
    // Start from byte zero once and filter by lastSeq. Priming directly at EOF would lose an event
    // appended in the gap between the initial read above and cursor construction.
    const feedCursor = new FeedLogCursor({ paths, sinceSeq: lastSeq });

    // watchFileFeed always runs a poll-fallback timer alongside fs.watch (not
    // gated on watch() succeeding), so a watcher setup/runtime failure can't
    // strand this command waiting forever — the prior hand-rolled watch()
    // here only logged "using poll-only" without ever actually polling.
    await watchFileFeed({
        path: paths.feedPath,
        debounceMs: WATCH_DEBOUNCE_MS,
        signal: controller.signal,
        onChange: async () => {
            const next = await feedCursor.readAppended();

            for (const [index, event] of next.entries()) {
                emitEvent({ event, format, names, position: { index: index + 1, total: next.length } });

                if (event.seq > lastSeq) {
                    lastSeq = event.seq;
                }
            }
        },
    });
}

export function registerListenCommand(program: Command): void {
    program
        .command("listen")
        .description("Follow a session feed in human-friendly form")
        .option("--session <id>", "Session id to follow")
        .option("--session-name <name>", "Pick session whose main agent has this name")
        .option("--recent-hour", "Only consider sessions active in the last hour when picking")
        .option(
            "--format <fmt>",
            "monitor | json | pretty (default: pretty in a terminal, monitor otherwise: a headline line, then the json line)"
        )
        .action(async (opts: ListenOpts) => {
            await runWithFriendlyErrors(() => runListen(opts));
        });
}
