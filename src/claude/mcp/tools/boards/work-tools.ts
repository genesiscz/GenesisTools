import type { AnnotationDto, AttemptDto, CardDto, MessageDto, StrokeDto } from "@app/dev-dashboard/contract/dto";
import { paths } from "@app/dev-dashboard/contract/endpoints";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { boardsFetch, compact } from "./http";

const log = logger.child({ component: "claude:mcp:boards:work" });

export async function handleSetStatus(args: { id: number; status: "open" | "working" | "in_review" }): Promise<string> {
    const a = await boardsFetch<AnnotationDto>(paths.annotation(args.id), {
        method: "PATCH",
        body: SafeJSON.stringify({ status: args.status, actor: "claude" }),
    });
    log.debug({ id: args.id, status: args.status }, "boards mcp: set_status");
    return compact(a);
}

export async function handleReply(args: { id: number; text: string }): Promise<string> {
    const m = await boardsFetch<MessageDto>(paths.annotationMessages(args.id), {
        method: "POST",
        body: SafeJSON.stringify({ body: args.text, author: "claude" }),
    });
    log.debug({ id: args.id }, "boards mcp: reply");
    return compact(m);
}

export async function handleAttachAfter(args: {
    id: number;
    project: string;
    branch: string;
    selector: string;
    file: string;
    commit?: string;
}): Promise<string> {
    const r = await boardsFetch<{ attempt: AttemptDto; card: CardDto }>(paths.annotationAttempts(args.id), {
        method: "POST",
        body: SafeJSON.stringify({
            project: args.project,
            branch: args.branch,
            selector: args.selector,
            file: args.file,
            agent: "claude",
            commit: args.commit ?? "",
        }),
    });
    log.debug(
        { id: args.id, project: args.project, branch: args.branch, selector: args.selector },
        "boards mcp: attach_after"
    );
    return compact(r);
}

/** Amber rect stroke on the annotation's card: GET annotation → derive rect path → POST strokes. */
export async function handleHighlight(args: {
    id: number;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    color?: string;
}): Promise<string> {
    const a = await boardsFetch<AnnotationDto>(paths.annotation(args.id));
    const r = { x: args.x ?? a.region.x, y: args.y ?? a.region.y, w: args.w ?? a.region.w, h: args.h ?? a.region.h };
    const path = [
        [r.x, r.y, 0.5],
        [r.x + r.w, r.y, 0.5],
        [r.x + r.w, r.y + r.h, 0.5],
        [r.x, r.y + r.h, 0.5],
        [r.x, r.y, 0.5],
    ];
    // Stroke path is stored in SOURCE-IMAGE px (same space as the region). The UI's InkLayer
    // converts card-scoped strokes to card space using payload.naturalWidth — the tool just
    // posts region-space coordinates as-is.
    const s = await boardsFetch<{ strokes: StrokeDto[] }>(paths.boardStrokes(a.boardSlug), {
        method: "POST",
        body: SafeJSON.stringify({
            strokes: [{ cardId: a.cardId, path, color: args.color ?? "#ffb020", width: 3, createdBy: "claude" }],
        }),
    });
    log.debug({ id: args.id, boardSlug: a.boardSlug, cardId: a.cardId }, "boards mcp: highlight");
    return compact(s);
}
