import type {
    AnnotationDto,
    AnnotationIntent,
    AnnotationStatus,
    AttemptDto,
    BoardDocDto,
    BoardSummaryDto,
    CardDto,
    EdgeDto,
    MessageDto,
    Region,
    StrokeDto,
} from "@app/dev-dashboard/contract/dto";
import { paths } from "@app/dev-dashboard/contract/endpoints";
import { SafeJSON } from "@app/utils/json";
import { fetchJson } from "@/lib/api";

/** A card_versions row — not part of the type-only contract (no DTO exists yet), so declared here. */
export interface CardVersionDto {
    version: number;
    setRef: string;
    setVersion: number;
    filePath: string;
    blobKey: string;
    attemptId: number | null;
    createdAt: string;
}

function jsonInit(method: string, body: unknown): RequestInit {
    return { method, headers: { "Content-Type": "application/json" }, body: SafeJSON.stringify(body) };
}

export const boardsApi = {
    list: (project?: string) =>
        fetchJson<{ boards: (BoardSummaryDto & { cardCount: number; openWork: number })[] }>(paths.boards(project)),
    create: (body: { slug: string; title?: string; boardType?: string; project?: string }) =>
        fetchJson<BoardSummaryDto>(paths.boards(), jsonInit("POST", body)),
    doc: (slug: string) => fetchJson<BoardDocDto>(paths.board(slug)),
    patchCard: (
        id: number,
        patch: Partial<Pick<CardDto, "x" | "y" | "w" | "h" | "z">> & { payload?: Record<string, unknown> }
    ) => fetchJson<CardDto>(paths.boardCard(id), jsonInit("PATCH", patch)),
    createCard: (slug: string, body: Record<string, unknown>) =>
        fetchJson<CardDto>(paths.boardCards(slug), jsonInit("POST", body)),
    deleteCard: (id: number) => fetchJson<{ ok: boolean }>(paths.boardCard(id), { method: "DELETE" }),
    cardVersions: (id: number) => fetchJson<{ versions: CardVersionDto[] }>(paths.boardCardVersions(id)),
    layout: (slug: string, moves: Array<{ id: number; x: number; y: number }>) =>
        fetchJson<{ ok: boolean }>(paths.boardLayout(slug), jsonInit("POST", { moves })),
    addStrokes: (slug: string, strokes: Array<{ cardId?: number; path: number[][]; color?: string; width?: number }>) =>
        fetchJson<{ strokes: StrokeDto[] }>(paths.boardStrokes(slug), jsonInit("POST", { strokes })),
    deleteStroke: (id: number) => fetchJson<{ ok: boolean }>(paths.boardStroke(id), { method: "DELETE" }),
    addEdge: (slug: string, edge: { fromCard: number; toCard?: number; toX?: number; toY?: number; label?: string }) =>
        fetchJson<EdgeDto>(paths.boardEdges(slug), jsonInit("POST", edge)),
    createAnnotation: (body: {
        board: string;
        cardId: number;
        region: Region;
        intent: AnnotationIntent;
        intentOther?: string;
        prompt: string;
        createdBy?: string;
    }) => fetchJson<AnnotationDto>(paths.annotations(), jsonInit("POST", body)),
    patchAnnotation: (id: number, patch: { status?: AnnotationStatus; region?: Region }) =>
        fetchJson<AnnotationDto>(paths.annotation(id), jsonInit("PATCH", patch)),
    deleteAnnotation: (id: number) => fetchJson<{ ok: boolean }>(paths.annotation(id), { method: "DELETE" }),
    cancelAnnotation: (id: number) => fetchJson<AnnotationDto>(paths.annotationCancel(id), { method: "POST" }),
    reactivateAnnotation: (id: number) => fetchJson<AnnotationDto>(paths.annotationReactivate(id), { method: "POST" }),
    reviseAnnotation: (id: number, prompt: string) =>
        fetchJson<AnnotationDto>(paths.annotationRevisions(id), jsonInit("POST", { prompt })),
    reply: (id: number, opts: { body: string; author: string }) =>
        fetchJson<MessageDto>(paths.annotationMessages(id), jsonInit("POST", opts)),
    verdict: (attemptId: number, verdict: "accept" | "reject") =>
        fetchJson<{ attempt: AttemptDto; annotation: AnnotationDto; card: CardDto }>(
            paths.attemptVerdict(attemptId),
            jsonInit("POST", { verdict })
        ),
    dispatch: (slug: string) =>
        fetchJson<{ opened: number[]; releasedQuestions: number[] }>(paths.boardDispatch(slug), { method: "POST" }),
    boardMessage: (slug: string, opts: { body: string; author?: string }) =>
        fetchJson<MessageDto>(paths.boardMessages(slug), jsonInit("POST", opts)),
    syncSet: (slug: string, body: { project: string; branch: string; selector: string }) =>
        fetchJson<{ updated: number; skippedFiles: string[] }>(paths.boardSyncSet(slug), jsonInit("POST", body)),
    getOperator: () => fetchJson<{ operator: string }>(paths.boardsOperator()),
    setOperator: (operator: string) =>
        fetchJson<{ operator: string }>(paths.boardsOperator(), jsonInit("PUT", { operator })),
};
