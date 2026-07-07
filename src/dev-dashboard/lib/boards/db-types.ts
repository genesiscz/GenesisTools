import type { Generated } from "kysely";

export interface SetsTable {
    id: Generated<number>;
    project: string;
    branch_slug: string;
    branch_raw: string;
    version: number;
    key: string;
    kind: string; // 'screenshots' | 'artifact' — unconstrained TEXT
    title: string;
    commit_sha: string;
    repo: string;
    source_ref: string; // "project/branch/key" of the source screenshot set ('' = none)
    name: string; // editable URL slug ('' = none)
    journey: string; // manifest journey header JSON ('' = none)
    file_count: number;
    bytes: number;
    created_at: string;
    updated_at: string;
}

export interface SetFilesTable {
    id: Generated<number>;
    set_id: number;
    path: string;
    mime: string;
    bytes: number;
    blob_key: string;
    width: number; // 0 when not an image
    height: number;
    meta: string; // JSON: { route?, label?, title?, note?, action?, ts?, surface? }
}

export interface BoardsTable {
    id: Generated<number>;
    slug: string;
    title: string;
    project: string;
    board_type: string; // 'board' | 'brainstorm' | ...
    elem_seq: number; // per-board E-number counter
    created_at: string;
    updated_at: string;
    archived_at: string; // '' = live
}

export interface BoardCardsTable {
    id: Generated<number>;
    board_id: number;
    kind: string; // unconstrained TEXT + free payload — new kinds need no migration
    x: number;
    y: number;
    w: number;
    h: number;
    z: number;
    set_ref: string; // "project/branch_slug/key" ('' for non-shot cards)
    set_version: number;
    file_path: string;
    blob_key: string;
    payload: string; // free JSON
    created_by: string;
    elem_no: number;
    current_version: number; // pointer into card_versions
    deleted_at: string; // '' = live (soft trash)
    created_at: string;
    updated_at: string;
}

export interface CardVersionsTable {
    id: Generated<number>;
    card_id: number;
    version: number;
    set_ref: string;
    set_version: number;
    file_path: string;
    blob_key: string;
    attempt_id: number; // 0 = not attempt-produced (sync/swap/paste)
    created_at: string;
}

export interface BoardStrokesTable {
    id: Generated<number>;
    board_id: number;
    card_id: number; // 0 = canvas stroke
    path: string; // JSON [[x,y,pressure], ...]
    color: string;
    width: number;
    created_by: string;
    created_at: string;
}

export interface BoardEdgesTable {
    id: Generated<number>;
    board_id: number;
    from_card: number;
    to_card: number; // 0 when point-anchored
    to_x: number;
    to_y: number;
    label: string;
    created_by: string;
    created_at: string;
}

export interface AnnotationsTable {
    id: Generated<number>;
    board_id: number;
    card_id: number;
    region: string; // JSON {x,y,w,h} in source-image px
    intent: string; // fix|investigate|refactor|redesign|reshoot|other
    intent_other: string;
    status: string; // staged|open|working|in_review|resolved|cancelled
    assignee: string; // 'claude'
    created_by: string;
    card_version: number; // card version the region was drawn on
    claimed_by: string;
    claimed_listener: number; // listener lease id, 0 = none
    claimed_at: string;
    created_at: string;
    updated_at: string;
}

export interface AnnotationRevisionsTable {
    id: Generated<number>;
    annotation_id: number;
    prompt: string;
    created_by: string;
    created_at: string;
}

export interface AnnotationMessagesTable {
    id: Generated<number>;
    annotation_id: number; // 0 = board-level message (then board_id set)
    board_id: number; // 0 = annotation message (then annotation_id set)
    author: string;
    body: string;
    created_at: string;
}

export interface AnnotationAttemptsTable {
    id: Generated<number>;
    annotation_id: number;
    revision_id: number;
    after_set_ref: string;
    after_version: number;
    after_file: string;
    after_blob_key: string;
    agent: string;
    commit_ref: string;
    verdict: string; // '' pending | 'accept' | 'reject'
    created_at: string;
}

export interface ListenersTable {
    id: Generated<number>;
    scope_kind: string; // 'all' | 'board' | 'project'
    scope: string; // board slug or project name ('' for all)
    branch: string;
    actor: string;
    session: string; // "host:pid"
    created_at: string;
    last_seen: string;
}

export interface BoardQuestionsTable {
    id: Generated<number>;
    board_id: number;
    card_id: number; // 0 = board-level
    prompt: string;
    options: string; // JSON array of {label,hint?,recommended?} | string
    answer: string; // JSON array of selected labels ('' = unanswered)
    answered_by: string;
    delivered: number; // 0|1 exactly-once work-queue drain
    staged: number; // 1 = answer held until dispatch
    multi: number; // 0|1
    created_at: string;
    answered_at: string;
}

export interface SettingsTable {
    key: string;
    value: string;
}

export interface BoardsDb {
    sets: SetsTable;
    set_files: SetFilesTable;
    boards: BoardsTable;
    board_cards: BoardCardsTable;
    card_versions: CardVersionsTable;
    board_strokes: BoardStrokesTable;
    board_edges: BoardEdgesTable;
    annotations: AnnotationsTable;
    annotation_revisions: AnnotationRevisionsTable;
    annotation_messages: AnnotationMessagesTable;
    annotation_attempts: AnnotationAttemptsTable;
    listeners: ListenersTable;
    board_questions: BoardQuestionsTable;
    settings: SettingsTable;
}
