export type HandoffStatus = "open" | "claimed" | "done" | "cancelled";

export interface HandoffTarget {
    sessionId?: string;
    sessionName?: string;
}

export interface HandoffTaskInput {
    id?: string;
    text: string;
    acceptanceCriteria?: string;
}

export interface HandoffProof {
    answer: string;
    commitIds?: string[];
    context?: string;
    attachmentIds?: string[];
}

/** Compact who-did-it stamp kept on tasks/comments/claims (full context lives on the event). */
export interface HandoffActor {
    sessionId: string | null;
    sessionName: string | null;
    agent: string;
    via?: string;
}

export interface HandoffTask {
    id: string;
    text: string;
    acceptanceCriteria?: string;
    checked: boolean;
    proof?: HandoffProof;
    checkedBy?: HandoffActor;
    checkedTs?: string;
    denied: boolean;
    deniedReason?: string;
    deniedBy?: HandoffActor;
    deniedTs?: string;
}

export interface HandoffClaim {
    sessionId: string | null;
    sessionName: string | null;
    branch: string | null;
    cwd: string | null;
    claimedAt: string;
    via: "target-match" | "explicit";
}

export interface HandoffComment {
    text: string;
    attachmentIds?: string[];
    by: HandoffActor;
    ts: string;
}

export interface HandoffAttachment {
    attachmentId: string;
    filename: string;
    mime: string;
    bytes: number;
    taskId?: string;
    note?: string;
    by: HandoffActor;
    ts: string;
    missing?: boolean;
}

/**
 * The `by` stamp on every event — AgentContext subset per spec §6.1, plus
 * `via: "dashboard"` for owner-authority UI events (agent: "human").
 */
export interface HandoffEventBy {
    sessionId: string | null;
    sessionTitle: string | null;
    agent: string;
    aiAgent: string | null;
    branch: string | null;
    cwd: string | null;
    repoRoot: string | null;
    project: string | null;
    commitSha: string | null;
    isWorktree: boolean;
    via?: "dashboard";
}

interface HandoffEventBase {
    ts: string;
    /**
     * Per-event correlation nonce: fold outcomes are persisted keyed by uid so the
     * appending process can report truthful results even when a CONCURRENT process
     * folded its batch first (spec §6.1 rules 2+4). Semantically inert for the fold.
     */
    uid: string;
    id: string;
    by: HandoffEventBy;
    /**
     * Poster credential echo for editId-authorized mutations — must live in the
     * event so a rebuild folds to the same accept/reject decisions (§6.1 rules 1+6).
     */
    editId?: string;
}

export type HandoffEvent =
    | (HandoffEventBase & {
          ev: "post";
          editId: string;
          title: string;
          description?: string;
          tasks: HandoffTaskInput[];
          target?: HandoffTarget;
          refs?: string[];
      })
    | (HandoffEventBase & { ev: "claim"; via: "target-match" | "explicit" })
    | (HandoffEventBase & { ev: "unclaim" })
    | (HandoffEventBase & { ev: "check_task"; taskId: string; proof: HandoffProof; force?: boolean })
    | (HandoffEventBase & { ev: "uncheck_task"; taskId: string })
    | (HandoffEventBase & { ev: "deny_task"; taskId: string; reason: string; force?: boolean })
    | (HandoffEventBase & { ev: "undeny_task"; taskId: string })
    | (HandoffEventBase & { ev: "comment"; text: string; attachmentIds?: string[] })
    | (HandoffEventBase & {
          ev: "attach";
          attachmentId: string;
          filename: string;
          mime: string;
          bytes: number;
          taskId?: string;
          note?: string;
      })
    | (HandoffEventBase & { ev: "add_tasks"; tasks: HandoffTaskInput[] })
    | (HandoffEventBase & { ev: "modify_task"; taskId: string; text?: string; acceptanceCriteria?: string })
    | (HandoffEventBase & {
          ev: "modify_handoff";
          title?: string;
          description?: string;
          target?: HandoffTarget | null;
          refs?: string[];
      })
    | (HandoffEventBase & { ev: "finish"; force?: boolean })
    | (HandoffEventBase & { ev: "cancel" })
    | (HandoffEventBase & { ev: "reopen" });

export type HandoffEventName = HandoffEvent["ev"];

/** Fully folded current state of one handoff (read-model row, deserialized). */
export interface Handoff {
    id: string;
    title: string;
    description?: string;
    status: HandoffStatus;
    tasks: HandoffTask[];
    target?: HandoffTarget;
    refs?: string[];
    postedBy: HandoffActor;
    postedByContext: HandoffEventBy;
    project: string | null;
    claimedBy: HandoffClaim[];
    comments: HandoffComment[];
    attachments: HandoffAttachment[];
    editId: string;
    createdTs: string;
    updatedTs: string;
    finishedTs?: string;
    finishedBy?: HandoffActor;
}

/** What the fold decided for one event — persisted by uid (see HandoffEventBase.uid). */
export interface FoldOutcome {
    applied: boolean;
    error?: string;
    info?: string[];
    noop?: boolean;
    assignedTaskIds?: string[];
}

/** One entry of handoff_action's `actions` array: bare verb string or object. */
export type HandoffActionInput = string | ({ action: string } & Record<string, unknown>);

export interface HandoffActionResult {
    action: string;
    ok: boolean;
    error?: string;
    info?: string[];
    assignedTaskIds?: string[];
    attachmentId?: string;
}

export interface HandoffListRow {
    id: string;
    title: string;
    status: HandoffStatus;
    tasks: string;
    progress?: string;
    target?: HandoffTarget;
    postedBy: { sessionName: string | null };
    claimedBy?: { sessionId: string | null; sessionName: string | null }[];
    project: string | null;
    ageHours: number;
}
