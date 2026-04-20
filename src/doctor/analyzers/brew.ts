import { Analyzer } from "@app/doctor/lib/analyzer";
import { isCommandAvailable, run, runInherit } from "@app/doctor/lib/run";
import type { AnalyzerCategory, AnalyzerContext, ExecutorContext, Finding } from "@app/doctor/lib/types";
import { SafeJSON } from "@app/utils/json";

export interface OutdatedPackage {
    name: string;
    installed: string[];
    current: string;
}

interface BrewOutdatedJson {
    formulae?: Array<{ name: string; installed_versions: string[]; current_version: string }>;
    casks?: Array<{ name: string; installed_versions: string[]; current_version: string }>;
}

export class BrewAnalyzer extends Analyzer {
    readonly id = "brew";
    readonly name = "Homebrew";
    readonly icon = "H";
    readonly category: AnalyzerCategory = "system";
    readonly cacheTtlMs = 24 * 60 * 60 * 1000;

    protected async *run(_ctx: AnalyzerContext): AsyncIterable<Finding> {
        const brewAvailable = await isCommandAvailable("brew");

        if (!brewAvailable) {
            yield {
                id: "brew-not-installed",
                analyzerId: this.id,
                title: "Homebrew not installed",
                detail: "Many doctor actions work better with brew. Install from https://brew.sh.",
                severity: "safe",
                actions: [],
            };
            return;
        }

        const outdatedRes = await run("brew", ["outdated", "--json=v2"], { timeoutMs: 15_000 });
        const outdated = outdatedRes.status === 0 ? parseBrewOutdated(outdatedRes.stdout) : [];

        if (outdated.length > 0) {
            yield {
                id: "brew-outdated",
                analyzerId: this.id,
                title: `${outdated.length} outdated brew package(s)`,
                detail: outdated
                    .slice(0, 10)
                    .map((pkg) => `${pkg.name} ${pkg.installed.join(",")} -> ${pkg.current}`)
                    .join("\n"),
                severity: "cautious",
                actions: [
                    {
                        id: "brew-upgrade",
                        label: "Run brew upgrade",
                        confirm: "yesno",
                        execute: async (_ctx: ExecutorContext, finding) => {
                            const status = await runInherit("brew", ["upgrade"]);

                            return {
                                findingId: finding.id,
                                actionId: "brew-upgrade",
                                status: status === 0 ? "ok" : "failed",
                            };
                        },
                    },
                ],
                metadata: { outdated },
            };
        }

        const leavesRes = await run("brew", ["leaves"], { timeoutMs: 10_000 });
        const leaves = leavesRes.status === 0 ? leavesRes.stdout.split("\n").filter((line) => line.trim()) : [];

        if (leaves.length > 30) {
            yield {
                id: "brew-many-leaves",
                analyzerId: this.id,
                title: `${leaves.length} top-level brew packages`,
                detail: "High count suggests some are forgotten installs. Review with `brew leaves`.",
                severity: "safe",
                actions: [],
                metadata: { count: leaves.length },
            };
        }
    }
}

export function parseBrewOutdated(raw: string): OutdatedPackage[] {
    try {
        const parsed = SafeJSON.parse(raw) as BrewOutdatedJson;
        const out: OutdatedPackage[] = [];

        for (const formula of parsed.formulae ?? []) {
            out.push({
                name: formula.name,
                installed: formula.installed_versions,
                current: formula.current_version,
            });
        }

        for (const cask of parsed.casks ?? []) {
            out.push({
                name: cask.name,
                installed: cask.installed_versions,
                current: cask.current_version,
            });
        }

        return out;
    } catch {
        return [];
    }
}
