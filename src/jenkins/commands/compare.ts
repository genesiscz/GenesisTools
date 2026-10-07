import { out } from "@genesiscz/utils/logger";
import { createBoxTable } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { getJenkinsBackend, refOnInstance } from "../lib/rest/client";
import { describeRun, fmtDuration, notFound, type Stage } from "../lib/rest/wfapi";

function signedDuration(delta: number): string {
    if (delta === 0) {
        return "=";
    }

    return `${delta > 0 ? "+" : "-"}${fmtDuration(Math.abs(delta))}`;
}

export async function cmdCompare(jobPath: string, b1: string, b2: string): Promise<void> {
    const backend = await getJenkinsBackend();
    const [d1, d2] = await Promise.all([
        describeRun(backend, jobPath, b1, { fullStages: true }),
        describeRun(backend, jobPath, b2, { fullStages: true }),
    ]);

    if (!d1) {
        notFound(b1);
    }

    if (!d2) {
        notFound(b2);
    }

    if (!d1 || !d2) {
        return;
    }

    const stages1: Stage[] = d1.stages ?? [];
    const stages2: Stage[] = d2.stages ?? [];
    const names = [...new Set([...stages1.map((s) => s.name), ...stages2.map((s) => s.name)])];

    const table = createBoxTable(["Stage", `#${b1}`, `#${b2}`, "Δ"]);

    for (const name of names) {
        const t1 = stages1.find((s) => s.name === name)?.durationMillis ?? 0;
        const t2 = stages2.find((s) => s.name === name)?.durationMillis ?? 0;
        table.push([name, fmtDuration(t1), fmtDuration(t2), signedDuration(t2 - t1)]);
    }

    table.push([
        "TOTAL",
        fmtDuration(d1.durationMillis),
        fmtDuration(d2.durationMillis),
        signedDuration(d2.durationMillis - d1.durationMillis),
    ]);
    out.println(`Compare: #${b1} vs #${b2}`);
    out.println(table.toString());
}

export function registerCompare(jenkins: Command): void {
    jenkins
        .command("compare")
        .description("Side-by-side stage comparison between two builds")
        .argument("<job-or-url>", "Jenkins job URL or path")
        .argument("<b1>", "First build number")
        .argument("<b2>", "Second build number")
        .action(async (jobOrUrl: string, b1: string, b2: string) => {
            const backend = await getJenkinsBackend();
            await cmdCompare(refOnInstance(backend.baseUrl, jobOrUrl).jobPath, b1, b2);
        });
}
