import { homedir } from "node:os";
import {
    hardDenyReason,
    kickDrainer,
    loadRmConfig,
    moveToTrash,
    type RmConfig,
    type RmTarget,
    resolveTarget,
    rmCallerFromRuntime,
} from "@genesiscz/utils/rm";

function denyReason(target: RmTarget, config: RmConfig): string | null {
    return hardDenyReason(target, { config, cwd: process.cwd(), home: homedir() });
}

/** Why `tools rm` would never delete `path` (its hard-deny list, keychains, VM disks, `config.protect`), or null. */
export function rmDenyReason(path: string): string | null {
    const target = resolveTarget(path, process.cwd());
    return target.kind === "missing" ? null : denyReason(target, loadRmConfig());
}

/**
 * Every doctor deletion: asks the `tools rm` hard-deny verdict, then moves the path into the rm trash under the rule
 * `doctor:<analyzerId>` with a grace of zero, so the drainer frees the space now and the ledger records it. No
 * approval request: the person already confirmed the doctor action. A path that is already gone is not removed and
 * not refused.
 */
export async function removeForDoctor(
    path: string,
    input: { analyzerId: string }
): Promise<{ removed: boolean; refusal?: string }> {
    const config = loadRmConfig();
    const target = resolveTarget(path, process.cwd());

    if (target.kind === "missing") {
        return { removed: false };
    }

    const denied = denyReason(target, config);

    if (denied) {
        return { removed: false, refusal: `${path}: ${denied}` };
    }

    let refusal: string | undefined;
    const batch = moveToTrash([{ target, rule: `doctor:${input.analyzerId}` }], {
        config,
        caller: rmCallerFromRuntime(),
        graceMinutes: 0,
        onRefused: (_request, reason) => {
            refusal = `${path}: ${reason}`;
        },
    });

    if (batch) {
        kickDrainer(config);
    }

    return refusal ? { removed: false, refusal } : { removed: batch !== null };
}
