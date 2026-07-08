import type { AnnotationDto, SetDetailDto } from "@app/dev-dashboard/contract/dto";
import type { BoardsRes, BoardsSetsRes, WorkListRes } from "@app/dev-dashboard/contract/endpoints";
import { paths } from "@app/dev-dashboard/contract/endpoints";
import { boardsBaseUrl, boardsFetch, compact } from "./http";

export async function handleListBoards(args: { project?: string }): Promise<string> {
    return compact(await boardsFetch<BoardsRes>(paths.boards(args.project)));
}

export async function handleListSets(args: { project: string; branch?: string }): Promise<string> {
    return compact(await boardsFetch<BoardsSetsRes>(paths.boardsSets(args.project, args.branch)));
}

export async function handleGetSet(args: { project: string; branch: string; selector: string }): Promise<string> {
    return compact(await boardsFetch<SetDetailDto>(paths.boardsSet(args.project, args.branch, args.selector)));
}

export async function handleListWork(args: {
    status?: string;
    board?: string;
    project?: string;
    branch?: string;
}): Promise<string> {
    return compact(await boardsFetch<WorkListRes>(paths.work(args)));
}

export async function handleGetAnnotation(args: { id: number }): Promise<string> {
    return compact(await boardsFetch<AnnotationDto>(paths.annotation(args.id)));
}

export async function handleGetCapsule(args: { id: number }): Promise<string> {
    const base = await boardsBaseUrl();
    return boardsFetch<string>(`${paths.annotationCapsule(args.id)}?base=${encodeURIComponent(base)}`, {
        rawText: true,
    });
}
