import { hostname } from "node:os";
import type { WorkWaitRes } from "@app/dev-dashboard/contract/endpoints";
import { paths } from "@app/dev-dashboard/contract/endpoints";
import { boardsFetch, compact } from "./http";

export async function handleWaitForWork(args: {
    board?: string;
    project?: string;
    branch?: string;
    timeoutSec?: number;
}): Promise<string> {
    if (!args.board && !args.project) {
        throw new Error(
            "scope required: pass {board} or {project[, branch]} — unscoped waits belong to other sessions"
        );
    }
    const q: Record<string, string | undefined> = {};
    if (args.board) {
        q.board = args.board;
    } else if (args.project) {
        q.project = args.project;
        if (args.branch) {
            q.branch = args.branch;
        }
    }
    q.timeout = String(Math.min(55, Math.max(1, args.timeoutSec ?? 50)));
    q.session = `${hostname()}:${process.pid}`;
    q.actor = "claude";
    return compact(await boardsFetch<WorkWaitRes>(paths.workWait(q)));
}
