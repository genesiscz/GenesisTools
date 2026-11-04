import type { ItemTransclusion } from "../transclusion-types";

/**
 * The plain shapes of an ask form, with no runtime code and no agent or harness types: the dev-dashboard contract
 * (and so the phone's type check) reaches them, and must not walk into the provider and harness graph that
 * `AskForm.poster` and `AskForm.transcriptAnchor` name. `./types` adds those two fields and re-exports the rest.
 */

export type AskFormStatus = "pending" | "answered" | "timeout" | "cancelled";

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
    /** The prompt and choices as written, and their inline tokens, when any were resolved at post time. */
    transclusion?: ItemTransclusion;
}

export interface AskImage {
    name: string;
    mime: string;
    /** base64 payload with no `data:` prefix. */
    base64: string;
}

export interface AskAnswer {
    /** Durable, local media context supplied by the user; it supplements, never replaces, a typed choice. */
    mediaContext?: string;
    itemId: string;
    freeText?: string;
    selectedChoices?: string[];
    fileTags?: string[];
    images?: AskImage[];
}

/** An ask form without its poster and transcript anchor. */
export interface AskFormFields {
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

export type PendingEventKind = "created" | "answered" | "cancelled" | "timeout";
