// The cache countdown. Each session writes `<agents>/mods-state/cache/<session>.json` when its main loop finishes a
// turn (the prompt cache was written then), and an `ended` mark when it ends. The band shows this session's minutes
// left dim, yellow under `mods.cacheBand.cautionMinutes` and red under `mods.cacheBand.warnMinutes`; with `others`
// on, it also shows every other session whose cache runs out inside the yellow window, so a reply that would rewrite
// a cold cache is visible from any open session. Reading the folder is a file listing, no process; it runs every 15 seconds.
import type { ElementTable, RenderElement } from "claude-code";
import type { CacheRow, CacheRows } from "../types";
import { idleDueAt } from "./idle";
import { agentsDir, type Feature, type Host, isRecord, settingsOf, shortDuration } from "./shared";

let rows: CacheRows = [];

/** Claude Code's prompt cache for a subscription session lives an hour after its last write. */
const TTL_MS = 60 * 60_000;
const EVERY_MS = 15_000;

interface CacheMark {
    sessionId: string;
    label: string;
    lastAt: number;
    ttlMs: number;
    ended?: boolean;
    /** When the main loop last compacted; at or after `lastAt` the old cache no longer matters. */
    compactedAt?: number;
}

async function folder(host: Host): Promise<string | undefined> {
    const dir = await agentsDir(host);

    return dir ? `${dir}/mods-state/cache` : undefined;
}

async function labelOf(host: Host): Promise<string> {
    const cwd = await host.cwd();
    const id = await host.sessionId();

    return `${cwd.split("/").filter(Boolean).pop() ?? "~"}·${id.slice(0, 6)}`;
}

async function mark(host: Host, why: "turn" | "ended" | "compacted"): Promise<void> {
    const dir = await folder(host);

    if (!dir) {
        return;
    }

    const sessionId = await host.sessionId();
    const now = Date.now();
    const held: CacheMark = {
        sessionId,
        label: await labelOf(host),
        lastAt: now,
        ttlMs: TTL_MS,
        ended: why === "ended",
        ...(why === "compacted" ? { compactedAt: now } : {}),
    };

    // A turn writes the cache again; an end or a compaction keeps the time of the last write.
    if (why !== "turn") {
        const before = await host.read(`${dir}/${sessionId}.json`).catch(() => undefined);

        try {
            const parsed: unknown = before ? JSON.parse(before) : undefined;

            if (isRecord(parsed) && typeof parsed.lastAt === "number") {
                held.lastAt = parsed.lastAt;
            }

            if (why === "ended" && isRecord(parsed) && typeof parsed.compactedAt === "number") {
                held.compactedAt = parsed.compactedAt;
            }
        } catch {
            // A broken mark is rewritten whole.
        }
    }

    await host.write(`${dir}/${sessionId}.json`, JSON.stringify(held));
}

/** This session's row, then the other live sessions inside the warning window, the soonest first. */
export function cacheRowsOf(marks: readonly CacheMark[], ownId: string, warnMs: number, now: number): CacheRows {
    const out: CacheRow[] = [];

    for (const held of marks) {
        const expiresAt = held.lastAt + held.ttlMs;
        const own = held.sessionId === ownId;
        const compacted = held.compactedAt !== undefined && held.compactedAt >= held.lastAt;

        if (own) {
            out.unshift({ sessionId: held.sessionId, label: held.label, expiresAt, own, compacted });
            continue;
        }

        if (!held.ended && !compacted && expiresAt > now && expiresAt - now <= warnMs) {
            out.push({ sessionId: held.sessionId, label: held.label, expiresAt, own, compacted });
        }
    }

    return [
        ...out.filter((row) => row.own),
        ...out.filter((row) => !row.own).sort((a, b) => a.expiresAt - b.expiresAt),
    ];
}

async function scan(host: Host): Promise<void> {
    const settings = (await settingsOf(host)).cacheBand;
    const dir = await folder(host);

    if (!settings.enabled || !dir) {
        rows = [];
        host.redraw();
        return;
    }

    const ownId = await host.sessionId();
    const entries = settings.others
        ? await host.list(dir).catch(() => [])
        : [{ name: `${ownId}.json`, kind: "file" as const }];
    const marks: CacheMark[] = [];

    for (const entry of entries) {
        if (entry.kind !== "file" || !entry.name.endsWith(".json")) {
            continue;
        }

        const text = await host.read(`${dir}/${entry.name}`).catch(() => undefined);

        try {
            const parsed: unknown = text ? JSON.parse(text) : undefined;

            if (isRecord(parsed) && typeof parsed.sessionId === "string" && typeof parsed.lastAt === "number") {
                marks.push({
                    sessionId: parsed.sessionId,
                    label: String(parsed.label ?? parsed.sessionId.slice(0, 6)),
                    lastAt: parsed.lastAt,
                    ttlMs: typeof parsed.ttlMs === "number" ? parsed.ttlMs : TTL_MS,
                    ended: parsed.ended === true,
                    ...(typeof parsed.compactedAt === "number" ? { compactedAt: parsed.compactedAt } : {}),
                });
            }
        } catch {
            // A mark half written by another session is read on the next pass.
        }
    }

    rows = cacheRowsOf(marks, ownId, alertMs(settings), Date.now());
    // Redrawn on every pass, so a countdown under the warning moves each 15 s.
    host.redraw();
}

export const cacheBand: Feature = {
    async start(host) {
        host.every(EVERY_MS, () => {
            void scan(host);
        });
        void scan(host);
    },
    async afterTurn(host, e) {
        if (e.agentId === undefined && (await settingsOf(host)).cacheBand.enabled) {
            await mark(host, "turn");
            void scan(host);
        }
    },
    async compacted(host, agentId) {
        if (agentId === undefined && (await settingsOf(host)).cacheBand.enabled) {
            await mark(host, "compacted");
            void scan(host);
        }
    },
};

/** The `ended` mark, so other sessions stop counting this one down. */
export async function markEnded(host: Host): Promise<void> {
    await mark(host, "ended").catch(() => undefined);
}

/** The wider of the two windows: a chip turns yellow, or red, from this much time left. */
function alertMs(settings: { warnMinutes: number; cautionMinutes: number }): number {
    return Math.max(settings.warnMinutes, settings.cautionMinutes) * 60_000;
}

/** `red` under the warning, `yellow` under the caution, undefined above both. */
export function cacheTone(left: number, warnMs: number, cautionMs: number): "red" | "yellow" | undefined {
    if (left <= warnMs) {
        return "red";
    }

    return left <= cautionMs ? "yellow" : undefined;
}

/** Focuses the cmux pane the row's session runs in (`tools claude cmux focus`); says so when no pane has it. */
async function focusSession(host: Host, row: CacheRow): Promise<void> {
    try {
        const run = await host.run(["tools", "claude", "cmux", "focus", row.sessionId, "--first"], {
            timeoutMs: 15_000,
        });

        if (run.exitCode !== 0) {
            host.toast(`No cmux pane runs ${row.label}`);
        }
    } catch {
        host.toast(`Could not focus ${row.label}: tools claude cmux focus did not run`);
    }
}

/** The band's cache row, or null with nothing to show. */
export async function cacheRow(host: Host, ui: ElementTable): Promise<RenderElement | null> {
    const held = rows;
    const settings = (await settingsOf(host)).cacheBand;

    if (!settings.enabled || held.length === 0) {
        return null;
    }

    const { Box, Button, Text } = ui;
    const now = Date.now();
    const warnMs = settings.warnMinutes * 60_000;
    const cautionMs = settings.cautionMinutes * 60_000;
    const cell = (row: CacheRow) => {
        const left = row.expiresAt - now;
        const name = row.own ? "cache" : `${row.label} cache`;

        if (row.compacted) {
            return (
                <Text key={row.sessionId} dimColor>
                    cache compacted
                </Text>
            );
        }

        if (left <= 0) {
            return row.own ? (
                <Text key={row.sessionId} dimColor>
                    {`${name} cold`}
                </Text>
            ) : null;
        }

        const tone = cacheTone(left, warnMs, cautionMs);
        const text = tone ? (
            <Text backgroundColor={tone} color={tone === "red" ? "white" : "black"} bold>
                {` ${name} ${shortDuration(left)} `}
            </Text>
        ) : (
            <Text dimColor>{`${name} ${Math.ceil(left / 60_000)}m`}</Text>
        );

        // The own chip also counts down to the idle compaction, which comes before the cache runs out.
        const due = row.own ? idleDueAt() : undefined;
        const idle =
            due !== undefined && due > now ? (
                <Text color={due - now <= warnMs ? "cyan" : undefined} dimColor={due - now > warnMs}>
                    {` · AC in ${shortDuration(due - now)}`}
                </Text>
            ) : null;

        // Another session's chip is a Button: a press focuses the cmux pane that session runs in.
        return row.own ? (
            <Box key={row.sessionId}>
                {text}
                {idle}
            </Box>
        ) : (
            <Button key={row.sessionId} plain onPress={() => void focusSession(host, row)}>
                {text}
            </Button>
        );
    };

    return (
        <Box key="cache-band" flexDirection="row" gap={1}>
            {held.map(cell)}
        </Box>
    );
}
