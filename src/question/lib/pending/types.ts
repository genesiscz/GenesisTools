/**
 * Wire types for interactive (blocking) ask forms.
 *
 * Shapes mirror Genesis' `@genesis/qa` field for field, so Genesis.app can point its
 * existing `QaSseClient` / `QaModels` at GenesisTools without a codec change. They are
 * re-declared rather than imported: `@genesis/qa` lives in another repository and is not
 * a dependency of this one, and a silent drift there must not break this store.
 */

export type AskFormStatus = "pending" | "answered" | "timeout" | "cancelled";

/**
 * Outcome of ONE wait call, deliberately distinct from the form status.
 *
 * A caller whose own budget runs out while the form is still pending gets
 * `budget_exhausted`, so "I stopped waiting" never reads as "the form expired".
 * Only `form.timeoutMs` retires a form, and that produces `timeout`. An id no form ever
 * carried is `not_found`: it used to arrive as `budget_exhausted` after 0ms, so a typo read
 * as "nobody answered in time" and every door had to re-derive the difference for itself.
 */
export type WaiterStatus = "answered" | "timeout" | "cancelled" | "budget_exhausted" | "not_found";

export interface AskChoice {
    id: string;
    label: string;
}

export interface AskItem {
    id: string;
    promptMarkdown: string;
    choices?: AskChoice[];
    allowMultiple?: boolean;
    allowFreeText?: boolean;
    /** Relative `@file` tags, resolved against the form cwd. */
    allowFileTags?: boolean;
    allowImagePaste?: boolean;
    required?: boolean;
}

export interface AskImage {
    name: string;
    mime: string;
    /** base64 payload with no `data:` prefix. */
    base64: string;
}

export interface AskAnswer {
    itemId: string;
    freeText?: string;
    selectedChoices?: string[];
    fileTags?: string[];
    images?: AskImage[];
}

export interface AskForm {
    id: string;
    createdAt: number;
    source?: string;
    sessionHint?: string;
    /** Project path the agent asked from. */
    projectPath: string;
    /** Resolved cwd for `@file` — nearest git root above projectPath, else projectPath. */
    cwd: string;
    items: AskItem[];
    status: AskFormStatus;
    answers?: Record<string, AskAnswer>;
    timeoutMs?: number;
    /** Set when the form left `pending`. */
    resolvedAt?: number;
    /** Id of the QaEntry written when the form was answered, so /qa can link the two. */
    entryId?: string;
}

export interface CreateAskItemInput {
    id?: string;
    promptMarkdown: string;
    /** Plain labels or `{id,label}`; normalized to id+label on the way in. */
    choices?: Array<string | AskChoice>;
    allowMultiple?: boolean;
    allowFreeText?: boolean;
    allowFileTags?: boolean;
    allowImagePaste?: boolean;
    required?: boolean;
}

export interface CreateAskFormInput {
    /** Omitted means the harness poster cwd, the same directory a handoff would stamp. */
    projectPath?: string;
    items: CreateAskItemInput[];
    timeoutMs?: number;
    id?: string;
    source?: string;
    sessionHint?: string;
}

export type PendingEventKind = "created" | "answered" | "cancelled" | "timeout";

export interface PendingEvent {
    id: string;
    ev: PendingEventKind;
    ts: number;
    form: AskForm;
}

export const MAX_IMAGE_BASE64_CHARS = 2_000_000;
export const MAX_IMAGES_PER_ANSWER = 4;
export const MAX_FILE_TAGS_PER_ANSWER = 20;
export const MAX_FREE_TEXT_CHARS = 16_000;
/** What a `wait` with no explicit budget gives up after. Matches the Genesis default. */
export const DEFAULT_WAIT_BUDGET_MS = 120_000;
/**
 * Upper bound on ONE wait call. A finite but absurd budget (`Number.MAX_VALUE`) passes an
 * `isFinite` check and then produces a deadline no clock reaches, so the request never ends.
 * A caller that wants longer waits again after this.
 */
export const MAX_WAIT_BUDGET_MS = 86_400_000;
/**
 * How long ONE answer may hold its claim on a pending form.
 *
 * The claim is taken before the history entry is written and dropped when the form resolves, so
 * this is the window a crashed answerer can hold a form for. It must outlast a whole
 * `recordAnswer` (a JSONL append plus its sinks, milliseconds) and stay short enough that a dead
 * process delays the next answer rather than wedging the form.
 */
export const ANSWER_CLAIM_TTL_MS = 30_000;
