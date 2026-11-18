/**
 * The session host seam: the app a coding agent's session runs in, where it can be raised, poked or kept warm. A cmux
 * pane is one host, a T3 Code thread another. Callers (the Genesis session window, the CLI) ask the host table and
 * never compare host names; a new host (tmux, a plain terminal) is one file in `hosts/` and one table entry.
 */

/** Every host kind. The table in `registry.ts` is keyed by it, so a kind without an adapter fails the compile. */
export type SessionHostKind = "cmux" | "t3";

export const SESSION_HOST_ACTIONS = ["focus", "wake", "keepalive"] as const;
export type SessionHostAction = (typeof SESSION_HOST_ACTIONS)[number];

/** What one button does for this session: enabled with its tooltip, or disabled with the reason a user reads. */
export type SessionHostActionState = { enabled: true; tip: string } | { enabled: false; reason: string };

/** Where a session lives, as a window shows it. The shape the Swift side decodes: change it with its decoder. */
export interface SessionHostView {
    kind: SessionHostKind;
    /** The kind of place, for a sentence: "cmux pane", "T3 Code thread". */
    place: string;
    /** This place: the pane's workspace and tab, the thread's title. */
    label: string;
    /** true: the agent works there now (a live pane, a running T3 turn). false: the place is known but idle or
     * closed. null: the host cannot tell. */
    live: boolean | null;
    /** One line on the state, for the sidebar: "Waiting in a cmux pane", "A turn runs in T3 Code". */
    note: string;
    actions: Record<SessionHostAction, SessionHostActionState>;
}

/** One session's answer: its host, or the reason none holds it (naming every host that was asked). */
export type SessionHostAnswer =
    | { sessionId: string; host: SessionHostView }
    | { sessionId: string; host: null; reason: string };

export type SessionHostActResult = { ok: true; detail: string } | { ok: false; reason: string };

/** What every host adapter answers. */
export interface SessionHostAdapter {
    kind: SessionHostKind;
    /** The kind of place, for the no-host sentence: "cmux pane". */
    place: string;
    /** The sessions this host holds, by id; a session it does not hold is absent. One read per call, not per id. */
    describe(sessionIds: readonly string[]): Promise<Map<string, SessionHostView>>;
    /** Performs an action on a session this host's `describe` answered for. It reads its own facts again, since the
     * place can change between the window's read and the click. */
    act(action: SessionHostAction, sessionId: string): Promise<SessionHostActResult>;
}

/** The line Wake sends: a poke that asks for a one-word answer, so the turn is short. */
export const WAKE_TEXT = 'Just poking, say "OK"';
