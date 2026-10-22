// The cache countdown. Each session writes `<agents>/mods-state/cache/<session>.json` when its main loop finishes a
// turn (the prompt cache was written then), and an `ended` mark when it ends. The band shows this session's minutes
// left dim, and red with a background under `mods.cacheBand.warnMinutes`; with `others` on, it also shows every
// other session whose cache runs out within that threshold, so a reply that would rewrite a cold cache is visible
// from any open session. Reading the folder is a file listing, no process; it runs every 15 seconds.
import type { ElementTable, RenderElement } from "claude-code";
import type { CacheRow, CacheRows } from "../types";
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

async function mark(host: Host, ended: boolean): Promise<void> {
    const dir = await folder(host);

    if (!dir) {
        return;
    }

    const sessionId = await host.sessionId();
    const held: CacheMark = { sessionId, label: await labelOf(host), lastAt: Date.now(), ttlMs: TTL_MS, ended };

    if (ended) {
        const before = await host.read(`${dir}/${sessionId}.json`).catch(() => undefined);

        try {
            const parsed: unknown = before ? JSON.parse(before) : undefined;

            if (isRecord(parsed) && typeof parsed.lastAt === "number") {
                held.lastAt = parsed.lastAt;
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

        if (own) {
            out.unshift({ sessionId: held.sessionId, label: held.label, expiresAt, own });
            continue;
        }

        if (!held.ended && expiresAt > now && expiresAt - now <= warnMs) {
            out.push({ sessionId: held.sessionId, label: held.label, expiresAt, own });
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
                });
            }
        } catch {
            // A mark half written by another session is read on the next pass.
        }
    }

    rows = cacheRowsOf(marks, ownId, settings.warnMinutes * 60_000, Date.now());
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
            await mark(host, false);
            void scan(host);
        }
    },
};

/** The `ended` mark, so other sessions stop counting this one down. */
export async function markEnded(host: Host): Promise<void> {
    await mark(host, true).catch(() => undefined);
}

/** The band's cache row, or null with nothing to show. */
export async function cacheRow(host: Host, ui: ElementTable): Promise<RenderElement | null> {
    const held = rows;
    const settings = (await settingsOf(host)).cacheBand;

    if (!settings.enabled || held.length === 0) {
        return null;
    }

    const { Box, Text } = ui;
    const now = Date.now();
    const warnMs = settings.warnMinutes * 60_000;
    const cell = (row: CacheRow) => {
        const left = row.expiresAt - now;
        const name = row.own ? "cache" : `${row.label} cache`;

        if (left <= 0) {
            return row.own ? (
                <Text key={row.sessionId} dimColor>
                    {`${name} cold`}
                </Text>
            ) : null;
        }

        return left <= warnMs ? (
            <Text key={row.sessionId} backgroundColor="red" color="white" bold>
                {` ${name} ${shortDuration(left)} `}
            </Text>
        ) : (
            <Text key={row.sessionId} dimColor>
                {`${name} ${Math.ceil(left / 60_000)}m`}
            </Text>
        );
    };

    return (
        <Box key="cache-band" flexDirection="row" gap={1}>
            {held.map(cell)}
        </Box>
    );
}
