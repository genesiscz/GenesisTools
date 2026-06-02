/** The kind of activity an event represents. The discriminant for TimelineEvent. */
export type TimelineEventType = "run" | "qa" | "terminal";

interface TimelineEventBase {
    /** Stable, source-unique id (used as the React key + the `timeline-event-<id>` testID). */
    id: string;
    type: TimelineEventType;
    /** Epoch milliseconds the event happened. The sole sort key (descending). */
    ts: number;
    /** One-line headline (task name / question / terminal name). */
    title: string;
    /** Optional dimmer second line (project / cwd / outcome). */
    subtitle?: string;
}

export interface RunTimelineEvent extends TimelineEventBase {
    type: "run";
    runId: string;
    exitCode: number | null;
    durationMs: number | null;
}

export interface QaTimelineEvent extends TimelineEventBase {
    type: "qa";
    tag: string;
    project: string;
}

export interface TerminalTimelineEvent extends TimelineEventBase {
    type: "terminal";
    command: string;
    cwd: string;
}

export type TimelineEvent = RunTimelineEvent | QaTimelineEvent | TerminalTimelineEvent;

/** GET /api/timeline response body — a flat, already-sorted (desc) array. */
export type TimelineRes = TimelineEvent[];
