import { Analyzer } from "@app/doctor/lib/analyzer";
import { run } from "@app/doctor/lib/run";
import type { AnalyzerCategory, AnalyzerContext, Finding } from "@app/doctor/lib/types";

export interface PowerProfile {
    cycleCount: number | null;
    condition: string | null;
    maxCapacityPct: number | null;
    fullyCharged: boolean | null;
    stateOfChargePct: number | null;
}

export class BatteryAnalyzer extends Analyzer {
    readonly id = "battery";
    readonly name = "Battery";
    readonly icon = "B";
    readonly category: AnalyzerCategory = "system";
    readonly cacheTtlMs = 24 * 60 * 60 * 1000;

    protected async *run(_ctx: AnalyzerContext): AsyncIterable<Finding> {
        const res = await run("system_profiler", ["SPPowerDataType"], { timeoutMs: 5_000 });

        if (res.status === 0) {
            const profile = parsePowerProfile(res.stdout);

            if (profile.cycleCount !== null) {
                yield batterySummaryFinding(profile);
            }
        }

        // `pmset -g thermlog` streams indefinitely on recent macOS — cap hard.
        const thermRes = await run("pmset", ["-g", "thermlog"], { timeoutMs: 2_000 });
        const events = thermRes.status === 0 || thermRes.timedOut ? parseThermLog(thermRes.stdout) : [];

        yield {
            id: "battery-thermal",
            analyzerId: this.id,
            title: events.length === 0 ? "No recent thermal throttling" : `${events.length} recent thermal event(s)`,
            detail: events.length === 0 ? undefined : events.slice(-5).join("\n"),
            severity: "safe",
            actions: [],
            metadata: { eventCount: events.length },
        };
    }
}

export function parsePowerProfile(raw: string): PowerProfile {
    const cycleMatch = raw.match(/Cycle Count:\s+(\d+)/);
    const condMatch = raw.match(/Condition:\s+(.+)/);
    const maxMatch = raw.match(/Maximum Capacity:\s+(\d+)\s*%/);
    const fullMatch = raw.match(/Fully Charged:\s+(Yes|No)/);
    const socMatch = raw.match(/State of Charge \(%\):\s+(\d+)/);

    return {
        cycleCount: cycleMatch ? Number.parseInt(cycleMatch[1], 10) : null,
        condition: condMatch ? condMatch[1].trim() : null,
        maxCapacityPct: maxMatch ? Number.parseInt(maxMatch[1], 10) : null,
        fullyCharged: fullMatch ? fullMatch[1] === "Yes" : null,
        stateOfChargePct: socMatch ? Number.parseInt(socMatch[1], 10) : null,
    };
}

export function parseThermLog(raw: string): string[] {
    if (!raw.trim()) {
        return [];
    }

    return raw.split("\n").filter((line) => line.trim().length > 0);
}

function batterySummaryFinding(profile: PowerProfile): Finding {
    return {
        id: "battery-summary",
        analyzerId: "battery",
        title: `Battery · cycle count ${profile.cycleCount} · ${profile.condition ?? "Unknown"} · ${
            profile.maxCapacityPct ?? "?"
        }% max`,
        detail: batteryChargeDetail(profile),
        severity: "safe",
        actions: [],
        metadata: { ...profile },
    };
}

function batteryChargeDetail(profile: PowerProfile): string | undefined {
    if (profile.stateOfChargePct === null) {
        return undefined;
    }

    return `Currently ${profile.stateOfChargePct}%${profile.fullyCharged ? " (full)" : ""}`;
}
