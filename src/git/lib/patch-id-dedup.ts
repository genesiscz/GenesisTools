export interface PatchIdCommit {
    hash: string;
    commitDate: string;
}

export async function computePatchIds(shas: string[], cwd: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    for (const sha of shas) {
        const showProc = Bun.spawn(["git", "show", "--no-color", sha], {
            cwd,
            stdout: "pipe",
            stderr: "ignore",
        });

        const patchProc = Bun.spawn(["git", "patch-id", "--stable"], {
            cwd,
            stdin: showProc.stdout,
            stdout: "pipe",
            stderr: "ignore",
        });

        const [showExit, patchExit, stdout] = await Promise.all([
            showProc.exited,
            patchProc.exited,
            new Response(patchProc.stdout).text(),
        ]);

        if (showExit !== 0 || patchExit !== 0) {
            continue;
        }

        const line = stdout.trim().split("\n")[0];

        if (!line) {
            continue;
        }

        const patchId = line.split(/\s+/)[0];

        if (patchId) {
            result.set(sha, patchId);
        }
    }

    return result;
}

export function dedupByPatchId<T extends PatchIdCommit>(commits: T[], patchIds: Map<string, string>): T[] {
    const groups = new Map<string, T[]>();
    const noPatchId: T[] = [];

    for (const commit of commits) {
        const patchId = patchIds.get(commit.hash);

        if (!patchId) {
            noPatchId.push(commit);
            continue;
        }

        const existing = groups.get(patchId) ?? [];
        existing.push(commit);
        groups.set(patchId, existing);
    }

    const kept: T[] = [...noPatchId];

    for (const group of groups.values()) {
        if (group.length === 1) {
            kept.push(group[0]);
            continue;
        }

        let best = group[0];

        for (const candidate of group.slice(1)) {
            if (candidate.commitDate > best.commitDate) {
                best = candidate;
            }
        }

        kept.push(best);
    }

    return kept;
}
