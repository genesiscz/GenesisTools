import type { Analyzer } from "@app/doctor/lib/analyzer";
import { Engine } from "@app/doctor/lib/engine";
import { executeActions } from "@app/doctor/lib/executor";
import { writeRunSummary } from "@app/doctor/lib/history";
import { formatBytes, sumBytes } from "@app/doctor/lib/size";
import type { ActionResult, EngineEvent, Finding } from "@app/doctor/lib/types";
import { type StageItem, stageAndConfirm } from "@app/utils/prompts/clack/trash-staging";
import * as p from "@app/utils/prompts/p";
import { setBackend } from "@app/utils/prompts/p";
import { clackBackend } from "@app/utils/prompts/p/clack-backend";
import pc from "picocolors";
import { confirmActions, type SelectedAction, selectFindings } from "./findings";
import { pickAnalyzers } from "./picker";
import { createProgressDriver } from "./progress";

export interface PlainRunOpts {
    analyzers: Analyzer[];
    runId: string;
    only?: string[];
    thorough: boolean;
    fresh: boolean;
    dryRun: boolean;
}

function stagedPathFor(finding: Finding): string | null {
    const path = finding.metadata?.path;

    if (typeof path === "string") {
        return path;
    }

    return null;
}

function splitStagedActions(items: SelectedAction[]): {
    stagedItems: StageItem[];
    directItems: SelectedAction[];
} {
    const stagedItems: StageItem[] = [];
    const directItems: SelectedAction[] = [];

    for (const item of items) {
        const path = item.action.staged ? stagedPathFor(item.finding) : null;

        if (path) {
            stagedItems.push({
                id: item.finding.id,
                path,
                bytes: item.finding.reclaimableBytes ?? 0,
                label: item.finding.title,
            });
            continue;
        }

        directItems.push(item);
    }

    return { stagedItems, directItems };
}

export async function runPlain(opts: PlainRunOpts): Promise<void> {
    setBackend(clackBackend);
    p.intro(pc.cyan("macOS Doctor"));

    const selectedAnalyzers = await pickAnalyzers({ available: opts.analyzers, only: opts.only });

    if (selectedAnalyzers.length === 0) {
        p.cancel("No analyzers selected.");
        return;
    }

    const names = new Map(selectedAnalyzers.map((analyzer) => [analyzer.id, analyzer.name] as const));
    const progress = createProgressDriver(names);
    const findingsById = new Map<string, Finding>();
    const engine = new Engine();

    engine.on("event", (event: EngineEvent) => {
        progress.onEvent(event);

        if (event.type === "finding") {
            findingsById.set(event.finding.id, event.finding);
        }
    });

    const startedAt = new Date();
    await engine.run(selectedAnalyzers, {
        concurrency: opts.thorough ? 8 : 4,
        thorough: opts.thorough,
        fresh: opts.fresh,
        runId: opts.runId,
        dryRun: opts.dryRun,
    });
    progress.dispose();

    const allFindings = Array.from(findingsById.values());
    const totalReclaim = sumBytes(allFindings);
    p.log.success(`${allFindings.length} findings - ${formatBytes(totalReclaim)} reclaimable`);

    const picked = await selectFindings(allFindings);

    if (picked.length === 0) {
        p.outro("Nothing to do.");
        return;
    }

    const toExecute = await confirmActions(picked);

    if (toExecute.length === 0) {
        p.outro("All actions cancelled.");
        return;
    }

    const { stagedItems, directItems } = splitStagedActions(toExecute);
    let executedResults: ActionResult[] = [];

    if (directItems.length > 0) {
        executedResults = await executeActions({
            runId: opts.runId,
            dryRun: opts.dryRun,
            items: directItems,
        });
    }

    if (stagedItems.length > 0 && opts.dryRun) {
        p.log.info(`Dry run: would stage ${stagedItems.length} item(s) in Trash.`);
    } else if (stagedItems.length > 0) {
        await stageAndConfirm({ items: stagedItems, summaryTitle: "Staged for permanent delete" });
    }

    const reclaimed = executedResults.reduce((acc, result) => acc + (result.actualReclaimedBytes ?? 0), 0);
    const endedAt = new Date();

    await writeRunSummary(opts.runId, {
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        analyzers: selectedAnalyzers.map((analyzer) => analyzer.id),
        totalReclaimedBytes: reclaimed,
    });

    p.outro(`Done - ${formatBytes(reclaimed)} reclaimed (direct) + ${stagedItems.length} staged`);
}
