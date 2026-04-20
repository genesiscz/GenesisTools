import { Analyzer } from "@app/doctor/lib/analyzer";
import { run } from "@app/doctor/lib/run";
import type { AnalyzerCategory, AnalyzerContext, ExecutorContext, Finding } from "@app/doctor/lib/types";

export interface Assertion {
    pid: number;
    processName: string;
    kind: string;
    name: string;
    heldFor: string;
}

export interface LaunchctlItem {
    pid: number | null;
    status: number | null;
    label: string;
}

export class StartupAnalyzer extends Analyzer {
    readonly id = "startup";
    readonly name = "Startup";
    readonly icon = "U";
    readonly category: AnalyzerCategory = "system";
    readonly cacheTtlMs = 7 * 24 * 60 * 60 * 1000;

    protected async *run(_ctx: AnalyzerContext): AsyncIterable<Finding> {
        const pmRes = await run("pmset", ["-g", "assertions"]);
        const assertions = pmRes.status === 0 ? parsePmsetAssertions(pmRes.stdout) : [];

        for (const assertion of assertions) {
            yield {
                id: `startup-assertion-${assertion.pid}-${assertion.kind}-${assertion.name}`,
                analyzerId: this.id,
                title: `${assertion.processName} (PID ${assertion.pid}) · ${assertion.kind}`,
                detail: assertion.name,
                severity: "safe",
                actions: [],
                metadata: { ...assertion },
            };
        }

        const lcRes = await run("launchctl", ["list"]);
        const items = lcRes.status === 0 ? parseLaunchctlList(lcRes.stdout) : [];
        const broken = items.filter((item) => item.status !== null && item.status !== 0);

        for (const item of broken.slice(0, 10)) {
            yield {
                id: `startup-broken-${item.label}`,
                analyzerId: this.id,
                title: `Broken user agent: ${item.label}`,
                detail: `Status: ${item.status}`,
                severity: "cautious",
                actions: [
                    {
                        id: "remove-user-agent",
                        label: "Remove with launchctl",
                        confirm: "yesno",
                        execute: async (_ctx: ExecutorContext, finding) => {
                            const res = await run("launchctl", ["remove", item.label]);

                            return {
                                findingId: finding.id,
                                actionId: "remove-user-agent",
                                status: res.status === 0 ? "ok" : "failed",
                                metadata: { label: item.label },
                            };
                        },
                    },
                ],
                metadata: { ...item },
            };
        }
    }
}

export function parsePmsetAssertions(raw: string): Assertion[] {
    const assertions: Assertion[] = [];

    for (const line of raw.split("\n")) {
        const match = line.match(/^\s*pid (\d+)\(([^)]+)\): \[0x[0-9a-f]+\] (\S+) ([A-Za-z]+) named: "([^"]+)"/i);
        if (match) {
            assertions.push({
                pid: Number.parseInt(match[1], 10),
                processName: match[2],
                heldFor: match[3],
                kind: match[4],
                name: match[5],
            });
        }
    }

    return assertions;
}

export function parseLaunchctlList(raw: string): LaunchctlItem[] {
    const items: LaunchctlItem[] = [];
    const lines = raw.split("\n").slice(1);

    for (const line of lines) {
        const parts = line.split("\t");
        if (parts.length < 3) {
            continue;
        }

        items.push({
            pid: parseNullableInt(parts[0]),
            status: parseNullableInt(parts[1]),
            label: parts.slice(2).join("\t"),
        });
    }

    return items;
}

function parseNullableInt(value: string): number | null {
    if (value === "-") {
        return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
}
