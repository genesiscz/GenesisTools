import type { LoopResumes, SessionFacts, SessionPause } from "@genesiscz/utils/agent-sessions/analysis-types";
import { catalogHistory } from "@genesiscz/utils/agent-sessions/open-service";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import { ACCOUNT_PROVIDER_ALIASES, type AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { type ResolvedTranscript, resolveTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { formatDuration } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";

const MINUTE = 60_000;
const edges = [1, 4, 5, 6, 15, 55, 60, 65];
const bucketNames = edges.map((edge, index) => (edges[index + 1] ? `${edge}-${edges[index + 1]}m` : `${edge}m+`));

interface Lifetime {
    kind: LoopResumes["kind"];
    model: string;
    writeTtl: SessionPause["writeTtl"];
    buckets: Record<string, Record<SessionPause["outcome"], number>>;
    longestHitMin: number | null;
    shortestMissMin: number | null;
}

export function addLifetimeEvidence(table: Map<string, Lifetime>, loops: LoopResumes[]): void {
    for (const loop of loops) {
        for (const pause of loop.pauses) {
            if (
                pause.gapMs < MINUTE ||
                pause.compacted ||
                pause.modelChanged ||
                pause.writeTtl === "none" ||
                pause.expected <= 0
            ) {
                continue;
            }

            const minutes = pause.gapMs / MINUTE;
            const bucket = bucketNames[edges.findLastIndex((edge) => minutes >= edge)];
            const key = [loop.kind, pause.model, pause.writeTtl].join("\0");
            const row: Lifetime = table.get(key) ?? {
                kind: loop.kind,
                model: pause.model,
                writeTtl: pause.writeTtl,
                buckets: {},
                longestHitMin: null,
                shortestMissMin: null,
            };
            row.buckets[bucket] ??= { hit: 0, partial: 0, miss: 0 };
            row.buckets[bucket][pause.outcome]++;
            if (pause.outcome === "hit") {
                row.longestHitMin = Math.max(row.longestHitMin ?? 0, minutes);
            } else if (pause.outcome === "miss") {
                row.shortestMissMin = Math.min(row.shortestMissMin ?? Infinity, minutes);
            }
            table.set(key, row);
        }
    }
}

interface ResumeOptions {
    provider?: AccountProviderAlias;
    sinceMs?: number;
    project?: string;
    minGapMs: number;
    ttlOnly?: boolean;
    waits?: boolean;
    main?: boolean;
    json?: boolean;
}

async function targets(ids: string[], opts: ResumeOptions): Promise<ResolvedTranscript[]> {
    const sessions = new Map<string, ResolvedTranscript>();
    for (const id of ids) {
        const found = await resolveTranscript(id, {}, opts.provider);
        sessions.set(found.filePath, found);
    }
    if (opts.sinceMs !== undefined) {
        for (const provider of opts.provider ? [opts.provider] : ACCOUNT_PROVIDER_ALIASES) {
            const { metadata } = await catalogHistory({
                provider,
                refresh: false,
                filters: { excludeAgents: true, mtimeFrom: opts.sinceMs, project: opts.project },
            });
            for (const row of metadata) {
                if (row.sessionId) {
                    sessions.set(row.filePath, {
                        provider,
                        sessionId: row.sessionId,
                        filePath: row.filePath,
                        source: "native",
                    });
                }
            }
        }
    }
    return [...sessions.values()];
}

export async function printResumes(ids: string[], opts: ResumeOptions): Promise<void> {
    const selected = await targets(ids, opts);
    const table = new Map<string, Lifetime>();
    const sessions: Array<{ sessionId: string; path: string; provider: string; loops: LoopResumes[] }> = [];
    const unavailable: Array<{ sessionId: string; provider: string; reason: string }> = [];
    for (const session of selected) {
        const facts: SessionFacts<LoopResumes> =
            session.source === "native"
                ? await resolveHistoryProvider(session.provider).reader.analysis.resumes(session.filePath, {
                      main: opts.main,
                  })
                : { supported: false, reason: "Worker output has no native model-call history" };
        if (!facts.supported) {
            unavailable.push({ sessionId: session.sessionId, provider: session.provider, reason: facts.reason });
            continue;
        }

        for (const loop of facts.items) {
            loop.pauses = loop.pauses.filter((pause) => pause.gapMs >= opts.minGapMs);
        }
        addLifetimeEvidence(table, facts.items);
        if (opts.ttlOnly) {
            continue;
        }
        if (opts.json) {
            sessions.push({
                sessionId: session.sessionId,
                provider: session.provider,
                path: session.filePath,
                loops: facts.items,
            });
            continue;
        }

        out.println(`Session ${session.sessionId}`);
        const rows = facts.items.flatMap((loop) =>
            loop.pauses
                .filter((p) => p.resumed || opts.waits)
                .map((p) => [
                    loop.kind,
                    loop.id,
                    p.model,
                    p.at,
                    formatDuration(p.gapMs),
                    p.resumed ? "resume" : "wait",
                    p.cause,
                    p.outcome,
                    String(p.rewrittenTokens),
                    [p.compacted && "compacted", p.modelChanged && "model changed"].filter(Boolean).join(", "),
                ])
        );
        out.println(
            rows.length
                ? formatTable(rows, [
                      "KIND",
                      "LOOP",
                      "MODEL",
                      "AT (UTC)",
                      "IDLE",
                      "PAUSE",
                      "CAUSE",
                      "CACHE",
                      "REWRITTEN (est.)",
                      "CHANGES",
                  ])
                : "No matching pauses."
        );
    }

    const ttl = [...table.values()];
    if (opts.json) {
        out.result({
            schema: "sessions.resumes@1",
            scanned: selected.length,
            unavailable,
            ...(opts.ttlOnly ? {} : { sessions }),
            ttl,
        });
        return;
    }

    out.println(
        `Cache lifetime by loop kind, model and written lifetime (${selected.length - unavailable.length} sessions read). Buckets show hit/partial/miss.`
    );
    out.println(
        ttl.length
            ? formatTable(
                  ttl.map((row) => [
                      row.kind,
                      row.model,
                      row.writeTtl,
                      ...bucketNames.map((name) => {
                          const cell = row.buckets[name];
                          return cell ? `${cell.hit}/${cell.partial}/${cell.miss}` : "-";
                      }),
                      row.longestHitMin?.toFixed(1) ?? "-",
                      row.shortestMissMin?.toFixed(1) ?? "-",
                  ]),
                  ["KIND", "MODEL", "WRITE", ...bucketNames, "LONGEST HIT (min)", "SHORTEST MISS (min)"]
              )
            : "No eligible pauses."
    );
    for (const reason of new Set(unavailable.map((item) => item.reason))) {
        out.println(reason);
    }
}
