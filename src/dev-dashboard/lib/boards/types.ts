export type AnnotationStatus = "staged" | "open" | "working" | "in_review" | "resolved" | "cancelled";
export type AnnotationIntent = "fix" | "investigate" | "refactor" | "redesign" | "reshoot" | "other";
export type WorkScope =
    | { kind: "all" }
    | { kind: "board"; board: string }
    | { kind: "project"; project: string; branch: string };

export interface Region {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface SetFileDto {
    path: string;
    mime: string;
    bytes: number;
    blobKey: string;
    width: number;
    height: number;
    meta: Record<string, unknown>;
}

export interface SetSummaryDto {
    id: number;
    project: string;
    branch: string;
    version: number;
    key: string;
    kind: string;
    title: string;
    name: string;
    sourceRef: string;
    fileCount: number;
    bytes: number;
    createdAt: string;
    updatedAt: string;
}

export interface SetDetailDto extends SetSummaryDto {
    files: SetFileDto[];
}

export interface BoardSummaryDto {
    id: number;
    slug: string;
    title: string;
    project: string;
    boardType: string;
    createdAt: string;
    updatedAt: string;
    archived: boolean;
}

export interface CardDto {
    id: number;
    boardId: number;
    kind: string;
    x: number;
    y: number;
    w: number;
    h: number;
    z: number;
    setRef: string;
    setVersion: number;
    filePath: string;
    blobKey: string;
    payload: Record<string, unknown>;
    createdBy: string;
    elemNo: number;
    currentVersion: number;
}

export interface StrokeDto {
    id: number;
    boardId: number;
    cardId: number | null;
    path: number[][];
    color: string;
    width: number;
    createdBy: string;
}

export interface EdgeDto {
    id: number;
    boardId: number;
    fromCard: number;
    toCard: number | null;
    toX: number;
    toY: number;
    label: string;
}

export interface MessageDto {
    id: number;
    annotationId: number | null;
    boardId: number | null;
    author: string;
    body: string;
    createdAt: string;
}

export interface AttemptDto {
    id: number;
    annotationId: number;
    revisionId: number;
    afterSetRef: string;
    afterVersion: number;
    afterFile: string;
    afterBlobKey: string;
    agent: string;
    commitRef: string;
    verdict: "" | "accept" | "reject";
    createdAt: string;
}

export interface RevisionDto {
    id: number;
    prompt: string;
    createdBy: string;
    createdAt: string;
}

export interface AnnotationDto {
    id: number;
    boardId: number;
    boardSlug: string;
    cardId: number;
    region: Region;
    intent: string;
    intentOther: string;
    status: AnnotationStatus;
    assignee: string;
    createdBy: string;
    cardVersion: number;
    prompt: string; // latest revision
    revisions: RevisionDto[];
    messages: MessageDto[];
    attempts: AttemptDto[];
    createdAt: string;
    updatedAt: string;
}

export interface QuestionDto {
    id: number;
    boardId: number;
    cardId: number | null;
    prompt: string;
    options: Array<{ label: string; hint?: string; recommended?: boolean }>;
    answer: string[] | null;
    answeredBy: string;
    staged: boolean;
    multi: boolean;
    createdAt: string;
    answeredAt: string;
}

export interface BoardDocDto {
    board: BoardSummaryDto;
    cards: CardDto[];
    strokes: StrokeDto[];
    edges: EdgeDto[];
    annotations: AnnotationDto[];
    boardMessages: MessageDto[];
    questions: QuestionDto[];
}

export interface ListenerDto {
    id: number;
    scopeKind: string;
    scope: string;
    branch: string;
    actor: string;
    session: string;
    createdAt: string;
    lastSeen: string;
}

export interface ChoiceItemDto {
    type: "choice";
    id: number;
    board: string;
    cardId: number | null;
    question: string;
    option: string[];
    multi: boolean;
    actor: string;
}

export interface WorkCapsuleDto {
    id: number;
    board: string;
    capsule: string;
}

export interface WaitResultDto {
    idle?: boolean;
    work?: WorkCapsuleDto[];
    choices?: ChoiceItemDto[];
    pending?: number;
    listener?: number;
}

export interface WorkItemDto {
    id: number;
    board: string;
    cardId: number;
    intent: string;
    /** For intent "other", the operator's custom label (rendered in place of "other"). */
    intentOther?: string;
    status: AnnotationStatus;
    prompt: string;
    boardTitle?: string;
    setRef?: string;
    file?: string;
    createdAt: string;
    updatedAt: string;
}

/** SSE frame: every event on /api/boards/:slug/events is one of these. */
export interface BoardEventDto {
    type: string;
    payload: unknown;
}
