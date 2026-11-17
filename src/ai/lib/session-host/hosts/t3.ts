import { loadPins, type SessionPin } from "@genesiscz/utils/agent-sessions/pins";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { type T3SessionThread, t3SessionThreads, t3ThreadHolding } from "@genesiscz/utils/t3code/session-threads";
import { sendT3ThreadMessage, t3CliPath } from "@genesiscz/utils/t3code/thread-cli";
import { t3Home } from "@genesiscz/utils/t3code/thread-env";
import {
    openT3DesktopLink,
    readT3ThreadPlaces,
    type T3ThreadPlace,
    t3AppInstalled,
    t3EnvironmentId,
    t3ThreadDesktopLink,
} from "@genesiscz/utils/t3code/thread-place";
import {
    type SessionHostActionState,
    type SessionHostActResult,
    type SessionHostAdapter,
    type SessionHostView,
    WAKE_TEXT,
} from "../types";

const { log } = logger.scoped("session-host:t3");

const PLACE = "T3 Code thread";

// `/keepalive` is a Claude Code command typed into a terminal; T3 Code sends it as plain text, which a Codex thread
// reads as a message. Wake is the one way to warm a T3 thread's cache.
const NO_KEEPALIVE = "T3 Code has no keepalive command. Wake sends a message instead.";

/** The edges of the T3 host, so a test runs it on a fixture home with no T3 Code, no `open` and no `t3` CLI. */
export interface T3HostDeps {
    home: () => string;
    threads: (home: string) => ReadonlyMap<string, T3SessionThread>;
    pins: () => Promise<ReadonlyMap<string, Pick<SessionPin, "host">>>;
    /** Every asked thread's place in one read; a thread the state database does not know is absent. */
    places: (threadIds: readonly string[], home: string) => ReadonlyMap<string, T3ThreadPlace>;
    environmentId: (home: string) => string | undefined;
    /** A Launch Services lookup (an osascript start): asked once per describe or act, never per session. */
    appInstalled: () => Promise<boolean>;
    cliInstalled: () => boolean;
    open: typeof openT3DesktopLink;
    send: typeof sendT3ThreadMessage;
}

const LIVE_DEPS: T3HostDeps = {
    home: () => t3Home(env.getProcessEnv()),
    threads: (home) => t3SessionThreads(home),
    pins: () => loadPins({ readOnly: true }),
    places: readT3ThreadPlaces,
    environmentId: t3EnvironmentId,
    appInstalled: t3AppInstalled,
    cliInstalled: () => t3CliPath() !== undefined,
    open: openT3DesktopLink,
    send: sendT3ThreadMessage,
};

interface HeldThread {
    threadId: string;
    place: T3ThreadPlace | undefined;
    link: string | undefined;
}

/** What this Mac has installed, read once for a whole describe (or one act), so N sessions cost one lookup. */
interface T3Installed {
    app: boolean;
    cli: boolean;
}

async function installed(deps: T3HostDeps): Promise<T3Installed> {
    return { app: await deps.appInstalled(), cli: deps.cliInstalled() };
}

function note(held: HeldThread): string {
    if (held.place?.deleted) {
        return "Its T3 Code thread was deleted";
    }

    if (held.place?.archived) {
        return "Its T3 Code thread is archived";
    }

    return held.place?.live ? "A turn runs in its T3 Code thread" : "Waiting in its T3 Code thread";
}

function actions(held: HeldThread, has: T3Installed): SessionHostView["actions"] {
    const gone = held.place?.deleted ? "The T3 Code thread was deleted." : undefined;
    const focus: SessionHostActionState = gone
        ? { enabled: false, reason: gone }
        : !has.app
          ? { enabled: false, reason: "T3 Code is not installed on this Mac." }
          : !held.link
            ? { enabled: false, reason: "T3 Code has no environment id here, so the thread has no link." }
            : { enabled: true, tip: "Open the thread in T3 Code" };
    const wake: SessionHostActionState = gone
        ? { enabled: false, reason: gone }
        : !has.cli
          ? { enabled: false, reason: "The t3 command is not installed, so nothing can send to the thread." }
          : { enabled: true, tip: "Send a poke as the thread's next message (it starts a turn)" };

    return {
        focus,
        wake,
        keepalive: { enabled: false, reason: NO_KEEPALIVE },
    };
}

/** The T3 Code host: a session T3 Code runs, found in T3 Code's own state and the session's newest pin. */
export function createT3SessionHost(deps: T3HostDeps = LIVE_DEPS): SessionHostAdapter {
    async function heldThreads(sessionIds: readonly string[]): Promise<Map<string, HeldThread>> {
        const home = deps.home();
        const threads = deps.threads(home);
        const held = new Map<string, HeldThread>();

        if (threads.size === 0) {
            return held;
        }

        const pins = await deps.pins();
        const holding = new Map<string, string>();

        for (const sessionId of sessionIds) {
            const thread = t3ThreadHolding({ thread: threads.get(sessionId), pin: pins.get(sessionId) });

            if (thread) {
                holding.set(sessionId, thread.threadId);
            }
        }

        if (holding.size === 0) {
            return held;
        }

        const environmentId = deps.environmentId(home);
        const places = deps.places([...holding.values()], home);

        for (const [sessionId, threadId] of holding) {
            held.set(sessionId, {
                threadId,
                place: places.get(threadId),
                link: environmentId ? t3ThreadDesktopLink({ environmentId, threadId }) : undefined,
            });
        }

        log.debug({ asked: sessionIds.length, held: held.size }, "sessions held by T3 Code threads");
        return held;
    }

    return {
        kind: "t3",
        place: PLACE,

        async describe(sessionIds) {
            const views = new Map<string, SessionHostView>();
            const held = await heldThreads(sessionIds);

            if (held.size === 0) {
                return views;
            }

            const has = await installed(deps);

            for (const [sessionId, thread] of held) {
                views.set(sessionId, {
                    kind: "t3",
                    place: PLACE,
                    label: thread.place?.title || thread.threadId,
                    live: thread.place ? thread.place.live : null,
                    note: note(thread),
                    actions: actions(thread, has),
                });
            }

            return views;
        },

        async act(action, sessionId): Promise<SessionHostActResult> {
            const held = (await heldThreads([sessionId])).get(sessionId);

            if (!held) {
                return { ok: false, reason: "No T3 Code thread holds this session any more." };
            }

            // Read again for the click: the app may have been installed or removed since the window's describe.
            const state = actions(held, await installed(deps))[action];

            if (!state.enabled) {
                return { ok: false, reason: state.reason };
            }

            const title = held.place?.title || held.threadId;

            switch (action) {
                case "focus": {
                    // `actions` enables Focus only with a link.
                    const opened = held.link ? await deps.open({ link: held.link }) : { opened: false, reason: "" };
                    return opened.opened
                        ? { ok: true, detail: `Opened "${title}" in T3 Code.` }
                        : { ok: false, reason: `T3 Code did not open the thread: ${opened.reason}` };
                }

                case "wake": {
                    const sent = await deps.send(held.threadId, WAKE_TEXT);

                    if (sent.kind === "sent") {
                        return { ok: true, detail: `Sent a poke to "${title}" (${sent.delivery}).` };
                    }

                    return sent.kind === "unknown"
                        ? { ok: false, reason: `${sent.reason} Check the thread before sending again.` }
                        : { ok: false, reason: `T3 Code refused the poke: ${sent.reason}` };
                }

                case "keepalive":
                    return { ok: false, reason: NO_KEEPALIVE };

                default: {
                    const never: never = action;
                    return { ok: false, reason: `Unknown action ${String(never)}` };
                }
            }
        },
    };
}

export const t3SessionHost: SessionHostAdapter = createT3SessionHost();
