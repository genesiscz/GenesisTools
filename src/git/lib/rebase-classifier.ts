export interface ClassifiableCommit {
    date: string;
    commitDate: string;
}

export interface RebaseCluster<T extends ClassifiableCommit> {
    landedAt: Date;
    commits: T[];
    authorDateRange: [Date, Date];
}

export function parseIsoMs(iso: string): number {
    return new Date(iso).getTime();
}

export function rangeBoundsMs(from: string, to: string): { fromMs: number; toMs: number } {
    const fromMs = new Date(`${from}T00:00:00.000Z`).getTime();
    const toMs = new Date(`${to}T23:59:59.999Z`).getTime();

    return { fromMs, toMs };
}

export function classifyCommit(
    commit: ClassifiableCommit,
    bounds: { fromMs: number; toMs: number }
): "authored" | "rebased" | "skip" {
    const aIMs = parseIsoMs(commit.date);
    const cIMs = parseIsoMs(commit.commitDate);

    if (aIMs >= bounds.fromMs && aIMs <= bounds.toMs) {
        return "authored";
    }

    if (aIMs < bounds.fromMs && cIMs >= bounds.fromMs && cIMs <= bounds.toMs) {
        return "rebased";
    }

    return "skip";
}

export function isLikelyResetAuthor(
    commit: ClassifiableCommit,
    allCommits: ClassifiableCommit[],
    resetAuthorWindowMs = 60_000
): boolean {
    const gap = parseIsoMs(commit.commitDate) - parseIsoMs(commit.date);

    if (gap >= resetAuthorWindowMs) {
        return false;
    }

    const cMinute = commit.commitDate.slice(0, 16);
    let sameMinuteCount = 0;

    for (const other of allCommits) {
        if (other.commitDate.slice(0, 16) !== cMinute) {
            continue;
        }

        const otherGap = parseIsoMs(other.commitDate) - parseIsoMs(other.date);

        if (otherGap < resetAuthorWindowMs) {
            sameMinuteCount++;
        }
    }

    return sameMinuteCount >= 2;
}

export function clusterRebasedByCI<T extends ClassifiableCommit>(
    rebased: T[],
    gapMs = 300_000
): RebaseCluster<T>[] {
    if (rebased.length === 0) {
        return [];
    }

    const sorted = [...rebased].sort(
        (a, b) => parseIsoMs(a.commitDate) - parseIsoMs(b.commitDate)
    );

    const clusters: RebaseCluster<T>[] = [];
    let current: T[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        const gap = parseIsoMs(cur.commitDate) - parseIsoMs(prev.commitDate);

        if (gap > gapMs) {
            clusters.push(buildCluster(current));
            current = [cur];
        } else {
            current.push(cur);
        }
    }

    clusters.push(buildCluster(current));

    return clusters;
}

function buildCluster<T extends ClassifiableCommit>(commits: T[]): RebaseCluster<T> {
    const authorTimes = commits.map((c) => parseIsoMs(c.date));
    const landedAt = new Date(parseIsoMs(commits[0].commitDate));

    return {
        landedAt,
        commits,
        authorDateRange: [new Date(Math.min(...authorTimes)), new Date(Math.max(...authorTimes))],
    };
}

export function formatYmd(d: Date): string {
    return d.toISOString().slice(0, 10);
}

export function formatClusterTimestamp(d: Date): string {
    const iso = d.toISOString();
    const date = iso.slice(0, 10);
    const time = iso.slice(11, 16);

    return `${date} ${time}`;
}
