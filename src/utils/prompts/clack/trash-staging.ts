import { spawnSync } from "node:child_process";
import logger from "@app/logger";
import * as p from "@app/utils/prompts/p";

export interface StageItem {
    id: string;
    path: string;
    bytes: number;
    label?: string;
}

export interface TrashStageFailure {
    item: StageItem;
    error: string;
}

export interface TrashStageResult {
    staged: StageItem[];
    emptied: boolean;
    failed: TrashStageFailure[];
}

export interface StageAndConfirmOpts {
    items: StageItem[];
    summaryTitle?: string;
    confirmPhrase?: string;
}

interface OsascriptResult {
    ok: boolean;
    stderr: string;
}

export function buildMoveScript(path: string): string {
    const escaped = path.replace(/"/g, '\\"');
    return `tell application "Finder" to delete POSIX file "${escaped}"`;
}

export function buildEmptyScript(): string {
    return 'tell application "Finder" to empty trash';
}

function runOsascript(script: string): OsascriptResult {
    const result = spawnSync("osascript", ["-e", script], { encoding: "utf8" });

    return {
        ok: result.status === 0,
        stderr: result.stderr ?? "",
    };
}

export async function stageItems(items: StageItem[]): Promise<{
    staged: StageItem[];
    failed: TrashStageFailure[];
}> {
    const staged: StageItem[] = [];
    const failed: TrashStageFailure[] = [];

    for (const item of items) {
        const { ok, stderr } = runOsascript(buildMoveScript(item.path));

        if (ok) {
            staged.push(item);
        } else {
            failed.push({ item, error: stderr.trim() });
            logger.warn({ path: item.path, stderr }, "trash move failed");
        }
    }

    return { staged, failed };
}

export async function emptyTrash(): Promise<boolean> {
    const { ok, stderr } = runOsascript(buildEmptyScript());

    if (!ok) {
        logger.warn({ stderr }, "empty trash failed");
    }

    return ok;
}

function formatGib(bytes: number): string {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function stageAndConfirm(opts: StageAndConfirmOpts): Promise<TrashStageResult> {
    if (opts.items.length === 0) {
        return { staged: [], emptied: false, failed: [] };
    }

    const { staged, failed } = await stageItems(opts.items);
    const totalBytes = staged.reduce((acc, item) => acc + item.bytes, 0);

    if (staged.length > 0) {
        const lines = staged.map((item) => `  ${item.label ?? item.path}`).join("\n");
        p.note(
            `${staged.length} item(s) moved to Trash - ${formatGib(totalBytes)}\n${lines}`,
            opts.summaryTitle ?? "Staged for permanent delete"
        );
    }

    if (failed.length > 0) {
        for (const failure of failed) {
            p.log.error(`Could not stage ${failure.item.path}: ${failure.error}`);
        }
    }

    if (staged.length === 0) {
        return { staged, emptied: false, failed };
    }

    const phrase = opts.confirmPhrase ?? "DELETE";
    const confirmed = await p.typedConfirm({
        message: `Empty the Trash to permanently free ${formatGib(totalBytes)}?`,
        phrase,
        caseSensitive: true,
    });

    if (!confirmed) {
        p.log.info("Left staged items in Trash. Drag out via Finder to recover.");
        return { staged, emptied: false, failed };
    }

    const emptied = await emptyTrash();

    if (emptied) {
        p.log.success(`Trash emptied - ${formatGib(totalBytes)} freed`);
    } else {
        p.log.warn("Trash empty command reported failure. Check Finder.");
    }

    return { staged, emptied, failed };
}
