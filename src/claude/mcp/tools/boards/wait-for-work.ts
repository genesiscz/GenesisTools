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
    const timeoutSec = Math.min(55, Math.max(1, args.timeoutSec ?? 50));
    q.timeout = String(timeoutSec);
    q.session = `${hostname()}:${process.pid}`;
    q.actor = "claude";
    // This is a long-poll: the server holds the connection open for up to timeoutSec, so the
    // client abort must exceed that (boardsFetch's default is too short and would cut it off).
    return compact(
        await boardsFetch<WorkWaitRes>(paths.workWait(q), {
            signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
        })
    );
}
