import { callCostUsd, priceOfCall } from "@genesiscz/utils/agent-sessions/analysis/cost";
import type { LoopResumes } from "@genesiscz/utils/agent-sessions/analysis-types";
import { byId } from "@genesiscz/utils/ai/catalog/static";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { priceUsage } from "@genesiscz/utils/ai/usage/spend/priced-usage";
import { median } from "@genesiscz/utils/math";
import { formatTable } from "@genesiscz/utils/table";

interface ColdSample {
    expected: number;
    gapMs: number;
    hit: boolean;
    rewriteUsd: number | null;
    followUsd: number | null;
    calls: number;
}

export interface ColdEvidence {
    edges: Map<number, { hit: number; other: number }>;
    samples: ColdSample[];
}

export function addColdEvidence(
    evidence: ColdEvidence,
    loops: LoopResumes[],
    provider: AccountProviderAlias,
    idleSeconds: number
): void {
    for (const loop of loops) {
        if (loop.kind !== "subagent" && loop.kind !== "teammate") {
            continue;
        }
        const byCall = new Map(loop.pauses.map((pause) => [pause.callId, pause]));
        let followCalls = 0;
        let followUsd: number | null = 0;
        for (let i = loop.calls.length - 1; i >= 0; i--) {
            const call = loop.calls[i];
            if (call.stop === "end_turn") {
                followCalls = 0;
                followUsd = 0;
            }
            const usd = callCostUsd(call, { agent: provider });
            followUsd = followUsd !== null && usd !== null ? followUsd + usd : null;
            followCalls++;
            const pause = byCall.get(call.id);
            if (!pause || pause.compacted || pause.modelChanged) {
                continue;
            }
            const seconds = pause.gapMs / 1000;
            const hit = pause.outcome === "hit";
            if (loop.kind === "subagent" && pause.writeTtl === "5m" && seconds >= 210 && seconds < 390) {
                const step = Math.floor(seconds / 15) * 15;
                const cell = evidence.edges.get(step) ?? { hit: 0, other: 0 };
                cell[hit ? "hit" : "other"]++;
                evidence.edges.set(step, cell);
            }
            if (pause.resumed && seconds >= idleSeconds) {
                const price = priceOfCall(call, { agent: provider });
                const hourShare = call.cacheWrite > 0 ? (call.cacheWrite1h ?? 0) / call.cacheWrite : 0;
                const writeRate = price
                    ? price.cacheWrite * (1 - hourShare) + (price.cacheWrite1h ?? price.cacheWrite) * hourShare
                    : null;
                const rewriteUsd = writeRate === null ? null : (pause.rewrittenTokens * writeRate) / 1_000_000;
                evidence.samples.push({
                    expected: pause.expected,
                    gapMs: pause.gapMs,
                    hit,
                    rewriteUsd,
                    followUsd,
                    calls: followCalls,
                });
            }
        }
    }
}

interface ColdBand {
    from: number;
    to: number | null;
    resumes: number;
    medianCalls: number | null;
    medianRewriteUsd: number | null;
    medianFollowUsd: number | null;
    unpricedFollowUps: number;
}

type FreshComparison =
    | { priced: false; reason: string }
    | {
          priced: true;
          priceModel: string;
          freshStart: number;
          calls: number;
          shares: number[];
          rows: Array<{ context: number; savedUsd: number[] }>;
      };

/** The cold comparison as data: `--json` prints it and `renderCold` draws it. */
export interface ColdComparison {
    idleSeconds: number;
    edges: Array<{ idleSeconds: number; hit: number; other: number }>;
    resumes: number;
    partialOrMiss: number;
    bands: ColdBand[];
    fresh: FreshComparison | null;
}

export function coldComparison(
    evidence: ColdEvidence,
    opts: { priceModel: string; freshStart: number; idleSeconds: number }
): ColdComparison {
    const { samples } = evidence;
    const comparison: ColdComparison = {
        idleSeconds: opts.idleSeconds,
        edges: [...evidence.edges]
            .sort(([a], [b]) => a - b)
            .map(([step, cell]) => ({ idleSeconds: step, hit: cell.hit, other: cell.other })),
        resumes: samples.length,
        partialOrMiss: samples.filter((p) => !p.hit).length,
        bands: [],
        fresh: null,
    };
    if (!samples.length) {
        return comparison;
    }

    const bands = [0, 50_000, 100_000, 150_000, 200_000, 300_000, 500_000];
    comparison.bands = bands.flatMap((from, i) => {
        const to = bands[i + 1] ?? null;
        const band = samples.filter((s) => s.expected >= from && (to === null || s.expected < to));
        if (!band.length) {
            return [];
        }

        const rewrite = band.flatMap((s) => s.rewriteUsd ?? []);
        const follow = band.flatMap((s) => s.followUsd ?? []);
        return [
            {
                from,
                to,
                resumes: band.length,
                medianCalls: median(band.map((s) => s.calls)) ?? null,
                medianRewriteUsd: median(rewrite) ?? null,
                medianFollowUsd: median(follow) ?? null,
                unpricedFollowUps: band.length - follow.length,
            },
        ];
    });
    const model = byId(opts.priceModel, "anthropic")?.id ?? opts.priceModel;
    const { price } = priceUsage({
        source: "claude",
        model,
        tokens: { input: opts.freshStart, output: 0, cacheWrite: 0, cacheRead: 0 },
    });
    if (!price) {
        comparison.fresh = { priced: false, reason: `no price for ${opts.priceModel}` };
        return comparison;
    }

    const n = median(samples.map((s) => s.calls)) ?? 1;
    const perToken = (price.cacheWrite + price.cacheRead * (n - 1)) / 1_000_000;
    const shares = [0, 0.25, 0.5, 0.75, 1];
    comparison.fresh = {
        priced: true,
        priceModel: opts.priceModel,
        freshStart: opts.freshStart,
        calls: n,
        shares,
        rows: [100_000, 150_000, 200_000, 300_000, 400_000, 600_000].map((context) => ({
            context,
            savedUsd: shares.map((s) => (context - opts.freshStart - s * context) * perToken),
        })),
    };
    return comparison;
}

export function renderCold(comparison: ColdComparison): string {
    const lines = [
        "Subagent cache edge (15-second intervals)",
        formatTable(
            comparison.edges.map((edge) => [String(edge.idleSeconds), String(edge.hit), String(edge.other)]),
            ["IDLE (s)", "HIT", "PARTIAL OR MISS"]
        ),
        `Cold resumes after ${comparison.idleSeconds}s: ${comparison.resumes}, including ${comparison.partialOrMiss} partial hits or misses.`,
    ];
    if (!comparison.resumes) {
        return lines.join("\n");
    }

    lines.push(
        formatTable(
            comparison.bands.map((band) => [
                `${band.from}–${band.to ?? "above"}`,
                String(band.resumes),
                String(band.medianCalls),
                band.medianRewriteUsd?.toFixed(2) ?? "unpriced",
                band.medianFollowUsd?.toFixed(2) ?? "unpriced",
                String(band.unpricedFollowUps),
            ]),
            ["CONTEXT", "RESUMES", "MEDIAN CALLS", "MEDIAN REWRITE ($)", "MEDIAN FOLLOW-UP ($)", "UNPRICED FOLLOW-UPS"]
        )
    );
    const { fresh } = comparison;
    if (!fresh) {
        return lines.join("\n");
    }

    if (!fresh.priced) {
        lines.push(`Fresh-agent comparison unavailable: ${fresh.reason}.`);
        return lines.join("\n");
    }

    lines.push(
        `Estimated dollars saved by starting fresh (${fresh.priceModel}, ${fresh.freshStart} initial tokens, ${fresh.calls} calls). Columns give the share of old context the fresh agent needs.`,
        formatTable(
            fresh.rows.map((row) => [String(row.context), ...row.savedUsd.map((usd) => usd.toFixed(2))]),
            ["CONTEXT", ...fresh.shares.map((s) => `${100 * s}%`)]
        )
    );
    return lines.join("\n");
}
