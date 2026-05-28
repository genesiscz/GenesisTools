export interface PatchIdCommit {
    hash: string;
    commitDate: string;
}

function commitDateMs(commitDate: string): number {
    const ms = new Date(commitDate).getTime();

    return Number.isNaN(ms) ? 0 : ms;
}

export async function computePatchIds(shas: string[], cwd: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    if (shas.length === 0) {
        return result;
    }

    const batchSize = 100;

    for (let i = 0; i < shas.length; i += batchSize) {
        const batch = shas.slice(i, i + batchSize);
        const showProc = Bun.spawn(["git", "show", "--no-color", ...batch], {
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

        for (const line of stdout.trim().split("\n")) {
            const parts = line.trim().split(/\s+/);

            if (parts.length < 2) {
                continue;
            }

            const [patchId, sha] = parts;
            result.set(sha.toLowerCase(), patchId);

            for (const inputSha of batch) {
                if (
                    inputSha.toLowerCase().startsWith(sha.toLowerCase()) ||
                    sha.toLowerCase().startsWith(inputSha.toLowerCase())
                ) {
                    result.set(inputSha, patchId);
                }
            }
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
            if (commitDateMs(candidate.commitDate) > commitDateMs(best.commitDate)) {
                best = candidate;
            }
        }

        kept.push(best);
    }

    return kept;
}
