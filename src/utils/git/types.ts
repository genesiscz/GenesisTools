export type { ExecResult as GitCommandResult } from "@app/utils/cli";

export interface BranchInfo {
    name: string;
    sha: string;
    isCurrent: boolean;
}

export interface DetailedCommitInfo {
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    message: string;
}
