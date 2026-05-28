import { Executor } from "@app/utils/cli";

export interface BranchAttribution {
    branch: string;
    trunkFallback: boolean;
}

export interface ResolveBranchOptions {
    excludeTrunks: string[];
    workitemBySha: Map<string, number[]>;
    cwd?: string;
}

const DETACHED = "(detached)";

function normalizeRefName(raw: string): string {
    let name = raw.trim();

    name = name.replace(/^remotes\/origin\//, "");
    name = name.replace(/^origin\//, "");
    name = name.replace(/~\d+$/, "");
    name = name.replace(/\^\d+$/, "");

    return name;
}

function trunkBaseName(name: string): string {
    const parts = name.split("/");

    return parts[parts.length - 1] ?? name;
}

function isTrunk(name: string, excludeTrunks: string[]): boolean {
    const base = trunkBaseName(name);

    for (const trunk of excludeTrunks) {
        if (name === trunk || base === trunk || name === `origin/${trunk}`) {
            return true;
        }
    }

    return false;
}

function isShaLike(value: string): boolean {
    return /^[0-9a-f]{7,40}$/i.test(value);
}

function pickBranchFromContains(branches: string[], excludeTrunks: string[], workitemIds: number[]): string | null {
    const filtered = branches
        .map(normalizeRefName)
        .filter((b) => b && !b.includes("HEAD detached") && !isTrunk(b, excludeTrunks));

    if (filtered.length === 0) {
        return null;
    }

    if (filtered.length === 1) {
        return filtered[0];
    }

    for (const id of workitemIds) {
        const idStr = String(id);

        for (const branch of filtered) {
            if (branch.toLowerCase().includes(idStr) || branch.toUpperCase().includes(`COL-${idStr}`)) {
                return branch;
            }
        }
    }

    return [...filtered].sort((a, b) => a.localeCompare(b))[0];
}

async function nameRevBatch(shas: string[], cwd: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    if (shas.length === 0) {
        return result;
    }

    const input = `${shas.join("\n")}\n`;
    const proc = Bun.spawn(
        ["git", "name-rev", "--name-only", "--refs=refs/heads/*", "--refs=refs/remotes/*", "--annotate-stdin"],
        {
            cwd,
            stdin: new Blob([input]),
            stdout: "pipe",
            stderr: "ignore",
        }
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        return result;
    }

    const lines = stdout.trim().split("\n").filter(Boolean);

    for (let i = 0; i < shas.length && i < lines.length; i++) {
        const line = lines[i].trim();
        const parts = line.split(/\s+/);
        const ref = parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
        const normalized = normalizeRefName(ref);

        if (isShaLike(normalized)) {
            continue;
        }

        result.set(shas[i], normalized);
    }

    return result;
}

async function branchesContaining(sha: string, cwd: string): Promise<string[]> {
    const executor = new Executor({ prefix: "git", verbose: false, cwd });
    const res = await executor.exec(["branch", "-a", "--contains", sha]);

    if (!res.success || !res.stdout.trim()) {
        return [];
    }

    return res.stdout
        .split("\n")
        .map((line) => line.trim().replace(/^\*\s+/, ""))
        .filter(Boolean);
}

async function buildReflogMap(cwd: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const executor = new Executor({ prefix: "git", verbose: false, cwd });
    const res = await executor.exec(["reflog", "show", "--all", "-n", "10000", "--date=iso"]);

    if (!res.success) {
        return map;
    }

    for (const line of res.stdout.split("\n")) {
        const match = line.match(/^([0-9a-f]{7,40})\s+(refs\/\S+?)@\{/i);

        if (!match) {
            continue;
        }

        const sha = match[1].toLowerCase();
        const ref = match[2];
        const existing = map.get(sha);

        if (!existing) {
            map.set(sha, ref);
            continue;
        }

        if (ref.startsWith("refs/heads/") && !existing.startsWith("refs/heads/")) {
            map.set(sha, ref);
        }
    }

    return map;
}

function lookupReflogRef(sha: string, reflogMap: Map<string, string>): string | undefined {
    const normalized = sha.toLowerCase();
    const direct = reflogMap.get(normalized);

    if (direct) {
        return direct;
    }

    for (const [key, ref] of reflogMap) {
        if (normalized.startsWith(key) || key.startsWith(normalized)) {
            return ref;
        }
    }

    return undefined;
}

function reflogBranchName(ref: string): string {
    if (ref.startsWith("refs/heads/")) {
        return normalizeRefName(ref.replace(/^refs\/heads\//, ""));
    }

    const worktreeHead = ref.match(/^worktrees\/[^/]+\/HEAD$/);

    if (worktreeHead) {
        return "";
    }

    return normalizeRefName(ref);
}

export async function resolveBranchForCommits(
    shas: string[],
    opts: ResolveBranchOptions
): Promise<Map<string, BranchAttribution>> {
    const cwd = opts.cwd ?? process.cwd();
    const result = new Map<string, BranchAttribution>();
    const excludeTrunks = opts.excludeTrunks;
    const reflogMap = await buildReflogMap(cwd);
    const nameRev = await nameRevBatch(shas, cwd);

    const needsFallback: string[] = [];

    for (const sha of shas) {
        const fromNameRev = nameRev.get(sha);

        if (fromNameRev && !isTrunk(fromNameRev, excludeTrunks)) {
            result.set(sha, { branch: fromNameRev, trunkFallback: false });
            continue;
        }

        needsFallback.push(sha);
    }

    const stillUnmapped: string[] = [];

    for (const sha of needsFallback) {
        const contains = await branchesContaining(sha, cwd);
        const picked = pickBranchFromContains(contains, excludeTrunks, opts.workitemBySha.get(sha) ?? []);

        if (picked) {
            result.set(sha, { branch: picked, trunkFallback: false });
            continue;
        }

        stillUnmapped.push(sha);
    }

    for (const sha of stillUnmapped) {
        const reflogRef = lookupReflogRef(sha, reflogMap);

        if (reflogRef) {
            const branch = reflogBranchName(reflogRef);

            if (branch && !isTrunk(branch, excludeTrunks)) {
                result.set(sha, { branch, trunkFallback: false });
                continue;
            }
        }

        const fromNameRev = nameRev.get(sha);
        const contains = await branchesContaining(sha, cwd);
        const trunkCandidates = new Set<string>();

        if (fromNameRev && isTrunk(fromNameRev, excludeTrunks)) {
            trunkCandidates.add(fromNameRev);
        }

        for (const b of contains.map(normalizeRefName)) {
            if (isTrunk(b, excludeTrunks)) {
                trunkCandidates.add(b);
            }
        }

        if (reflogRef) {
            const rb = reflogBranchName(reflogRef);

            if (rb && isTrunk(rb, excludeTrunks)) {
                trunkCandidates.add(rb);
            }
        }

        if (trunkCandidates.size > 0) {
            const trunk = [...trunkCandidates].sort((a, b) => a.localeCompare(b))[0];
            result.set(sha, { branch: trunkBaseName(trunk), trunkFallback: true });
            continue;
        }

        result.set(sha, { branch: DETACHED, trunkFallback: false });
    }

    return result;
}

export function formatBranchTag(attribution: BranchAttribution | undefined): string {
    if (!attribution) {
        return "";
    }

    if (attribution.branch === DETACHED) {
        return DETACHED;
    }

    if (attribution.trunkFallback) {
        return `[trunk: ${attribution.branch}]`;
    }

    return `[${attribution.branch}]`;
}
