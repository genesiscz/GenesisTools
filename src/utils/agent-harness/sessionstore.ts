import type { Input, InputID } from "./inbox";
import type { Response } from "./llm";
import { isTerminal, type Operation, type OperationID } from "./operation";
import type { CallStatus } from "./tool";

/**
 * Append-only session history and operation state, ported from `harness/session` and
 * `harness/sessionstore`. `MemoryStore` is the in-process implementation the tests and Pi
 * use; the Go `localfile` store (with its golden JSONL sessions) is not ported.
 */

export type SessionID = string;
export type TurnID = string;
export type TurnType = "regular" | "compaction";

export interface Session {
    ID: SessionID;
    CreatedAt: string;
}

export interface Turn {
    ID: TurnID;
    PreviousTurnID: TurnID;
    Type: TurnType;
}

export type Sequence = number;

/** The cursor before the first assigned sequence. */
export const BEFORE_FIRST: Sequence = 0;

export type ItemKind = "fork" | "input" | "turn" | "model_response" | "tool_call_status";

export interface Fork {
    ParentID: SessionID;
    PreviousTurnID: TurnID;
}

export interface ModelResponse {
    TurnID: TurnID;
    Response: Response;
}

export interface ToolCallStatus {
    TurnID: TurnID;
    CallID: string;
    Status: CallStatus;
    Operations?: Operation[];
}

interface ItemBase {
    Sequence?: Sequence;
    RecordedAt?: string;
}

export type Item = ItemBase &
    (
        | { Kind: "fork"; Data: Fork }
        | { Kind: "input"; Data: Input }
        | { Kind: "turn"; Data: Turn }
        | { Kind: "model_response"; Data: ModelResponse }
        | { Kind: "tool_call_status"; Data: ToolCallStatus }
    );

export interface Snapshot {
    Session: Session;
}

export interface SessionInfo {
    ID: SessionID;
    LastUpdatedAt: string;
}

export interface Page {
    Items: Item[];
    NextAfter: Sequence;
    More: boolean;
}

export interface ResumeState {
    Snapshot: Snapshot;
    /** Unfinished operations and terminal states missing from tool-call history. */
    Operations: Operation[];
    ExternalInputIDs: InputID[];
}

export interface Store {
    items(id: SessionID, after: Sequence, limit: number): Promise<Page>;
    appendInput(id: SessionID, input: Input): Promise<void>;
    appendTurn(id: SessionID, turn: Turn): Promise<void>;
    appendModelResponse(id: SessionID, response: ModelResponse): Promise<void>;
    /** Appends the status and its operation snapshots; the first append also initializes those operations. */
    appendToolCallStatus(id: SessionID, status: ToolCallStatus): Promise<void>;
    /** Stores a complete state; the latest state for its id wins. */
    saveOperation(id: SessionID, operation: Operation): Promise<void>;
    resume(id: SessionID): Promise<ResumeState>;
}

export function emptyResume(sessionID: SessionID, createdAt = new Date(0).toISOString()): ResumeState {
    return { Snapshot: { Session: { ID: sessionID, CreatedAt: createdAt } }, Operations: [], ExternalInputIDs: [] };
}

/** One session in memory. Items get their sequence on append; operations keep the latest state. */
export class MemoryStore implements Store {
    readonly itemList: Item[] = [];
    readonly operations = new Map<string, Operation>();
    /** When the session was opened; `resume` reports it, not the time of the resume. */
    readonly createdAt: string;

    constructor(
        readonly sessionID: SessionID,
        private readonly now: () => string = () => new Date().toISOString()
    ) {
        this.createdAt = this.now();
    }

    private append(item: Item): void {
        this.itemList.push({ ...item, Sequence: this.itemList.length + 1, RecordedAt: this.now() });
    }

    async items(_id: SessionID, after: Sequence, limit: number): Promise<Page> {
        if (limit <= 0) {
            throw new Error("invalid page size");
        }

        // `append` numbers items 1, 2, 3… in list order, so the item after sequence `after` sits at
        // index `after`: a page is one slice, not a filter over the whole history per page (which
        // made restoring an n-item session O(n²/limit)).
        const start = Math.max(0, Math.min(this.itemList.length, Math.floor(after)));
        const page = this.itemList.slice(start, start + limit);
        const last = page.at(-1)?.Sequence ?? after;
        return { Items: page, NextAfter: last, More: start + page.length < this.itemList.length };
    }

    async appendInput(_id: SessionID, input: Input): Promise<void> {
        this.append({ Kind: "input", Data: input });
    }

    async appendTurn(_id: SessionID, turn: Turn): Promise<void> {
        this.append({ Kind: "turn", Data: turn });
    }

    async appendModelResponse(_id: SessionID, response: ModelResponse): Promise<void> {
        this.append({ Kind: "model_response", Data: response });
    }

    async appendToolCallStatus(_id: SessionID, status: ToolCallStatus): Promise<void> {
        for (const operation of status.Operations ?? []) {
            if (!this.operations.has(operation.ID)) {
                this.operations.set(operation.ID, operation);
            }
        }

        this.append({ Kind: "tool_call_status", Data: status });
    }

    async saveOperation(_id: SessionID, operation: Operation): Promise<void> {
        this.operations.set(operation.ID, operation);
    }

    /**
     * The `ResumeState` contract, as localfile's `storedState.resume()` keeps it: only external input
     * ids (a control or crash input is redelivered, never deduplicated), unfinished operations plus
     * terminal ones whose last tool-call snapshot was still running, and the creation time.
     */
    async resume(id: SessionID): Promise<ResumeState> {
        const externalInputIDs: InputID[] = [];
        const pending = new Set<OperationID>();

        for (const item of this.itemList) {
            if (item.Kind === "input" && item.Data.Kind === "external") {
                externalInputIDs.push(item.Data.ID);
            }

            if (item.Kind === "tool_call_status") {
                for (const value of item.Data.Operations ?? []) {
                    if (isTerminal(value.Status)) {
                        pending.delete(value.ID);
                    } else {
                        pending.add(value.ID);
                    }
                }
            }
        }

        return {
            Snapshot: { Session: { ID: id, CreatedAt: this.createdAt } },
            Operations: [...this.operations.values()].filter(
                (operation) => !isTerminal(operation.Status) || pending.has(operation.ID)
            ),
            ExternalInputIDs: externalInputIDs,
        };
    }
}
