import { mkdir, rm } from "node:fs/promises";
import { guardPaths } from "./path-guard";
import type { Action, ActionResult, ConfirmMode, Finding } from "./types";

/** Every action `doctor act` may run. Anything else (kill, install,
 *  reveal, reinstall, clipboard) is `category-not-allowed`. */
export function isActable(action: Action): boolean {
    return action.kind === "remove-path" || action.kind === "command";
}

export function metadataPaths(finding: Finding): string[] {
    const paths = finding.metadata?.paths;

    if (Array.isArray(paths)) {
        return paths.filter((path): path is string => typeof path === "string");
    }

    const single = finding.metadata?.path;
    return typeof single === "string" ? [single] : [];
}

/** The fingerprint of a finding's path set: `sha256:` + hex of the sorted paths joined by newlines. `--json` prints it
 *  per finding, and `doctor act --expect-paths <id>=<hash>` refuses a set that changed since the user reviewed it. */
export function pathsHash(paths: string[]): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update([...paths].sort().join("\n"));
    return `sha256:${hasher.digest("hex")}`;
}

export function metadataBlockers(finding: Finding): string[] {
    const blockers = finding.metadata?.blockers;
    return Array.isArray(blockers) ? blockers.filter((b): b is string => typeof b === "string") : [];
}

export interface RemovePathsActionOpts {
    id: string;
    label: string;
    confirm: ConfirmMode;
    confirmPhrase?: string;
    recreateEmpty?: boolean;
    analyzerId: string;
    home: string;
    allowRoots: () => string[];
}

/**
 * A `remove-path` action: deletes `finding.metadata.paths`. The interactive UIs call `execute`; `doctor act` runs its
 * own remover over the same paths (it also offers the Trash). Both go through the same path guard, and a finding with
 * blockers (a running owner, an open writer) is refused here too.
 */
export function removePathsAction(opts: RemovePathsActionOpts): Action {
    return {
        id: opts.id,
        label: opts.label,
        confirm: opts.confirm,
        ...(opts.confirmPhrase !== undefined ? { confirmPhrase: opts.confirmPhrase } : {}),
        kind: "remove-path",
        ...(opts.recreateEmpty ? { recreateEmpty: true } : {}),
        execute: async (_ctx, finding): Promise<ActionResult> => {
            const blockers = metadataBlockers(finding);

            if (blockers.length > 0) {
                return { findingId: finding.id, actionId: opts.id, status: "skipped", error: blockers.join("; ") };
            }

            const paths = metadataPaths(finding);
            const guard = guardPaths({
                paths,
                allowRoots: opts.allowRoots(),
                home: opts.home,
                analyzerId: opts.analyzerId,
            });

            if (!guard.ok) {
                return { findingId: finding.id, actionId: opts.id, status: "failed", error: guard.error };
            }

            try {
                for (const path of paths) {
                    await rm(path, { recursive: true, force: true });

                    if (opts.recreateEmpty) {
                        await mkdir(path, { recursive: true });
                    }
                }
            } catch (err) {
                return {
                    findingId: finding.id,
                    actionId: opts.id,
                    status: "failed",
                    error: err instanceof Error ? err.message : String(err),
                    metadata: { paths },
                };
            }

            return {
                findingId: finding.id,
                actionId: opts.id,
                status: "ok",
                actualReclaimedBytes: finding.reclaimableBytes,
                metadata: { paths },
            };
        },
    };
}
