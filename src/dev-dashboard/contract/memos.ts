/**
 * Memo to action (F28). Types only (`contract-purity.test.ts`). A daemon task (`hub-memo-scan`, `tools hub memos scan`)
 * transcribes each new iPhone Voice Memo that iCloud brings to the Mac, splits it into todos, a note and a task for an
 * agent, stores it and pushes one notice; the phone lists them (`/api/gateway/memos`) and runs each action once.
 */

export type MemoActionKind = "reminders" | "note" | "agent";

export interface MemoDto {
    id: string;
    memoId: number;
    title: string;
    recordedAt: string;
    transcript: string;
    todos: string[];
    note: string;
    /** A task worth handing to an agent; null when the memo holds none. */
    agentTask: string | null;
    /** When each action ran; absent until it did. */
    done: Partial<Record<MemoActionKind, string>>;
}

export interface MemosDto {
    memos: MemoDto[];
    /** Null until the first scan primed the list (memos recorded before it are not offered). */
    primedAt: string | null;
}

export interface MemoActInput {
    id: string;
    action: MemoActionKind;
    /** The agents board key of the session the task goes to (`agent` only). */
    sessionKey?: string;
}

export interface MemoActReceiptDto {
    id: string;
    action: MemoActionKind;
    ok: boolean;
    detail: string;
}
