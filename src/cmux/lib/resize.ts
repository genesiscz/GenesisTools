import logger from "@app/logger";
import { runCmuxOk } from "@app/cmux/lib/cli";
import { paneList } from "@app/cmux/lib/socket";

export interface ResizeTarget {
    paneRef: string;
    columns: number;
    rows: number;
}

const TOLERANCE_CELLS = 1;
const MAX_ITERATIONS = 6;

export interface ConvergeResult {
    iterations: number;
    converged: boolean;
    deltas: Array<{ paneRef: string; dCols: number; dRows: number }>;
}

/**
 * Iteratively resize panes in a workspace toward target column/row counts.
 *
 * cmux's `resize-pane` is relative (-L|-R|-U|-D, in cells). We greedily apply per-pane
 * deltas; cmux propagates the change to neighbours, so we re-read after each pass and
 * loop until everyone is within {@link TOLERANCE_CELLS} or we hit {@link MAX_ITERATIONS}.
 */
export async function convergeToTarget(
    workspaceRef: string,
    targets: ResizeTarget[],
): Promise<ConvergeResult> {
    const targetByRef = new Map<string, ResizeTarget>();
    for (const target of targets) {
        targetByRef.set(target.paneRef, target);
    }

    let iteration = 0;
    let converged = false;
    let deltas: Array<{ paneRef: string; dCols: number; dRows: number }> = [];

    while (iteration < MAX_ITERATIONS) {
        const layout = await paneList(workspaceRef);
        deltas = [];
        let needWork = false;

        for (const pane of layout.panes) {
            const target = targetByRef.get(pane.ref);
            if (!target) {
                continue;
            }
            const dCols = target.columns - pane.columns;
            const dRows = target.rows - pane.rows;
            deltas.push({ paneRef: pane.ref, dCols, dRows });
            if (Math.abs(dCols) > TOLERANCE_CELLS || Math.abs(dRows) > TOLERANCE_CELLS) {
                needWork = true;
            }
        }

        if (!needWork) {
            converged = true;
            break;
        }

        // Apply biggest deltas first so neighbours absorb the change.
        const sorted = [...deltas].sort(
            (a, b) =>
                Math.max(Math.abs(b.dCols), Math.abs(b.dRows)) -
                Math.max(Math.abs(a.dCols), Math.abs(a.dRows)),
        );

        for (const { paneRef, dCols, dRows } of sorted) {
            if (Math.abs(dCols) > TOLERANCE_CELLS) {
                const direction = dCols > 0 ? "-R" : "-L";
                await tryResize(workspaceRef, paneRef, direction, Math.abs(dCols));
            }
            if (Math.abs(dRows) > TOLERANCE_CELLS) {
                const direction = dRows > 0 ? "-D" : "-U";
                await tryResize(workspaceRef, paneRef, direction, Math.abs(dRows));
            }
        }

        iteration += 1;
    }

    if (!converged) {
        const finalLayout = await paneList(workspaceRef);
        deltas = [];
        converged = true;
        for (const pane of finalLayout.panes) {
            const target = targetByRef.get(pane.ref);
            if (!target) {
                continue;
            }
            const dCols = target.columns - pane.columns;
            const dRows = target.rows - pane.rows;
            deltas.push({ paneRef: pane.ref, dCols, dRows });
            if (Math.abs(dCols) > TOLERANCE_CELLS || Math.abs(dRows) > TOLERANCE_CELLS) {
                converged = false;
            }
        }
    }

    if (!converged) {
        logger.warn({ iteration, deltas }, "[resize] did not fully converge");
    }
    return { iterations: iteration, converged, deltas };
}

async function tryResize(
    workspaceRef: string,
    paneRef: string,
    direction: "-L" | "-R" | "-U" | "-D",
    amount: number,
): Promise<void> {
    try {
        await runCmuxOk([
            "resize-pane",
            "--workspace",
            workspaceRef,
            "--pane",
            paneRef,
            direction,
            "--amount",
            String(amount),
        ]);
    } catch (error) {
        logger.warn(
            { error: error instanceof Error ? error.message : String(error), workspaceRef, paneRef, direction, amount },
            "[resize] resize-pane failed; skipping this delta",
        );
    }
}
