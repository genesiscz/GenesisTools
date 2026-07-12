import type { AnnotationDto, SetDetailDto } from "@app/dev-dashboard/contract/dto";
import type { BoardsRes, BoardsSetsRes, WorkListRes } from "@app/dev-dashboard/contract/endpoints";
import { paths } from "@app/dev-dashboard/contract/endpoints";
import { logger } from "@app/logger";
import { boardsBaseUrl, boardsFetch, compact } from "./http";

const log = logger.child({ component: "claude:mcp:boards" });

export async function handleListBoards(args: { project?: string }): Promise<string> {
    const path = paths.boards(args.project);
    const res = await boardsFetch<BoardsRes>(path);
    log.debug({ project: args.project, path, count: res.boards.length }, "boards mcp: list_boards");
    // Each row carries its clickable page url so agents relay the authoritative
    // dev-dashboard link instead of guessing a host/port.
    const base = await boardsBaseUrl();
    return compact({ boards: res.boards.map((b) => ({ ...b, url: `${base}/boards/${b.slug}` })) });
}

export async function handleListSets(args: { project: string; branch?: string }): Promise<string> {
    const path = paths.boardsSets(args.project, args.branch);
    const res = await boardsFetch<BoardsSetsRes>(path);
    log.debug({ project: args.project, branch: args.branch, path, count: res.sets.length }, "boards mcp: list_sets");
    return compact(res);
}

export async function handleGetSet(args: { project: string; branch: string; selector: string }): Promise<string> {
    const path = paths.boardsSet(args);
    const res = await boardsFetch<SetDetailDto>(path);
    log.debug(
        { project: args.project, branch: args.branch, selector: args.selector, path, count: res.files.length },
        "boards mcp: get_set"
    );
    return compact(res);
}

export async function handleListWork(args: {
    status?: string;
    board?: string;
    project?: string;
    branch?: string;
}): Promise<string> {
    const path = paths.work(args);
    const res = await boardsFetch<WorkListRes>(path);
    log.debug({ ...args, path, count: res.work.length }, "boards mcp: list_work");
    return compact(res);
}

export async function handleGetAnnotation(args: { id: number }): Promise<string> {
    const path = paths.annotation(args.id);
    const res = await boardsFetch<AnnotationDto>(path);
    log.debug({ id: args.id, path }, "boards mcp: get_annotation");
    return compact(res);
}

export async function handleGetCapsule(args: { id: number }): Promise<string> {
    const base = await boardsBaseUrl();
    const path = `${paths.annotationCapsule(args.id)}?base=${encodeURIComponent(base)}`;
    const res = await boardsFetch<string>(path, { rawText: true });
    log.debug({ id: args.id, path }, "boards mcp: get_capsule");
    return res;
}
