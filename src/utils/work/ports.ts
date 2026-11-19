/**
 * What the work package needs from tool code. `src/work/adapters/` implements these; the package imports no `@app/*`.
 */
import type { Database } from "bun:sqlite";
import type { SyncDeps } from "./connectors/sync";
import type { WorkerStamp } from "./model/item";

export interface DeliveryReceipt {
    outcome: "delivered" | "queued" | "nobody-alive" | "unknown";
    to: WorkerStamp | null;
    route?: string;
    target?: string;
    at: string;
}

export interface SessionPlace {
    label: string;
    live: boolean | null;
    wake?: string;
}

export interface SessionDelivery {
    deliver(input: { sessionId: string; harness: string; text: string; key: string }): Promise<DeliveryReceipt>;
    place(sessionId: string, harness?: string): Promise<SessionPlace | null>;
}

/** One write into the old handoff log, while it is the writer of handoff ticks, claims and text (shadow mode). */
export type LegacyAction =
    | { action: "check_task"; handoff: string; taskId: string; proof: { answer: string; commitIds?: string[] } }
    | { action: "uncheck_task"; handoff: string; taskId: string }
    | { action: "deny_task"; handoff: string; taskId: string; reason: string }
    | { action: "undeny_task"; handoff: string; taskId: string }
    | { action: "modify_task"; handoff: string; taskId: string; text?: string; acceptanceCriteria?: string }
    | { action: "comment"; handoff: string; text: string }
    | { action: "claim"; handoff: string }
    | { action: "unclaim"; handoff: string }
    | {
          action: "add_tasks";
          handoff: string;
          tasks: { text: string; acceptanceCriteria?: string; item?: string }[];
          /** The owner adds them: the old store wants the poster's credential, which the owner may use. */
          asOwner?: boolean;
      }
    | {
          action: "post";
          title: string;
          description?: string;
          project?: string;
          target?: { agent?: string; sessionId?: string };
          tasks: { text: string; acceptanceCriteria?: string; item?: string }[];
      };

export interface LegacyWriteResult {
    ok: boolean;
    error?: string;
    /** The id of a posted handoff. */
    handoff?: string;
    /** The task ids the old store assigned, in input order. */
    taskIds?: string[];
}

export interface LegacyHandoffs {
    /** Repeating an operation ID returns the existing successful effect when it already committed. */
    write(action: LegacyAction, operationId?: string): Promise<LegacyWriteResult>;
    /** What the old store would answer to these actions, in order, without writing; one result per action. */
    check(actions: LegacyAction[]): Promise<LegacyWriteResult[]>;
    /** When both models share a database, fold on the caller's write connection. */
    atomic?(db: Database): { write(action: LegacyAction): LegacyWriteResult; flush(): void } | undefined;
}

/** Who else belongs to the caller: the sessions whose live claims a spotted item may pair with. */
export interface LineageResolver {
    /** Session ids of the caller's lead (a T3 parent thread's session, for one). Empty when none is known. */
    leadSessions(input: { sessionId: string | null; parentThreadId: string | null }): Promise<string[]>;
}

/**
 * The connector table and its project rule loader. The tool side owns the table (a new
 * connector is one folder there); the library runs the pairings, the push and the pull through it.
 */
export interface ConnectorPort {
    syncDeps(): SyncDeps;
}
