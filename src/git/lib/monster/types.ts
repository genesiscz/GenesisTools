export type Tier = 0 | 1 | 2 | 3;

export interface ScoredFile {
    /** Repo-relative POSIX path. */
    path: string;
    score: number;
    tier: Tier;
    tierName: string;
    lines: number;
    ageDays: number;
    fanIn: number;
    fanOut: number;
}

export interface MonsterReport {
    /** Absolute directory that was analyzed. */
    dir: string;
    fileCount: number;
    /** Sum of every file's score. */
    repoMonsterSize: number;
    /** Highest-scoring file, or null when no source files were found. */
    scariest: (ScoredFile & { roar: string }) | null;
    leaderboard: ScoredFile[];
}
