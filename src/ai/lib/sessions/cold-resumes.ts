import { callCostUsd, priceOfCall } from "@genesiscz/utils/agent-sessions/analysis/cost";
import type { LoopResumes } from "@genesiscz/utils/agent-sessions/analysis-types";
import { byId } from "@genesiscz/utils/ai/catalog/static";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { priceUsage } from "@genesiscz/utils/ai/usage/spend/priced-usage";
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

function median(values: number[]): number | null {
    if (!values.length) {
        return null;
    }
    return values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

export function renderCold(
    evidence: ColdEvidence,
    opts: { priceModel: string; freshStart: number; idleSeconds: number }
): string {
    const { samples } = evidence;
    const lines = [
        "Subagent cache edge (15-second intervals)",
        formatTable(
            [...evidence.edges]
                .sort(([a], [b]) => a - b)
                .map(([step, cell]) => [String(step), String(cell.hit), String(cell.other)]),
            ["IDLE (s)", "HIT", "PARTIAL OR MISS"]
        ),
        `Cold resumes after ${opts.idleSeconds}s: ${samples.length}, including ${samples.filter((p) => !p.hit).length} partial hits or misses.`,
    ];
    if (!samples.length) {
        return lines.join("\n");
    }
    const bands = [0, 50_000, 100_000, 150_000, 200_000, 300_000, 500_000];
    const rows = bands.flatMap((from, i) => {
        const to = bands[i + 1] ?? Infinity;
        const band = samples.filter((s) => s.expected >= from && s.expected < to);
        if (!band.length) {
            return [];
        }
        const rewrite = band.flatMap((s) => s.rewriteUsd ?? []);
        const follow = band.flatMap((s) => s.followUsd ?? []);
        return [
            [
                `${from}–${to === Infinity ? "above" : to}`,
                String(band.length),
                String(median(band.map((s) => s.calls))),
                median(rewrite)?.toFixed(2) ?? "unpriced",
                median(follow)?.toFixed(2) ?? "unpriced",
                String(band.length - follow.length),
            ],
        ];
    });
    lines.push(
        formatTable(rows, [
            "CONTEXT",
            "RESUMES",
            "MEDIAN CALLS",
            "MEDIAN REWRITE ($)",
            "MEDIAN FOLLOW-UP ($)",
            "UNPRICED FOLLOW-UPS",
        ])
    );
    const model = byId(opts.priceModel, "anthropic")?.id ?? opts.priceModel;
    const { price } = priceUsage({
        source: "claude",
        model,
        tokens: { input: opts.freshStart, output: 0, cacheWrite: 0, cacheRead: 0 },
    });
    if (!price) {
        lines.push(`Fresh-agent comparison unavailable: no price for ${opts.priceModel}.`);
        return lines.join("\n");
    }
    const n = median(samples.map((s) => s.calls)) ?? 1;
    const perToken = (price.cacheWrite + price.cacheRead * (n - 1)) / 1_000_000;
    const shares = [0, 0.25, 0.5, 0.75, 1];
    lines.push(
        `Estimated dollars saved by starting fresh (${opts.priceModel}, ${opts.freshStart} initial tokens, ${n} calls). Columns give the share of old context the fresh agent needs.`,
        formatTable(
            [100_000, 150_000, 200_000, 300_000, 400_000, 600_000].map((c) => [
                String(c),
                ...shares.map((s) => ((c - opts.freshStart - s * c) * perToken).toFixed(2)),
            ]),
            ["CONTEXT", ...shares.map((s) => `${100 * s}%`)]
        )
    );
    return lines.join("\n");
}
