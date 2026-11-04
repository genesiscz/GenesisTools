import {
    createDashboardClient,
    type DashboardClient,
    ENDPOINTS,
    type EndpointMethod,
    type EventSourceLike,

    pathMatches,
    paths,
    QA_STREAM_PATH,
} from "@dd/contract";
import { SafeJSON } from "@genesiscz/utils/json";
import { MOCK_BOARD, MOCK_PROMPTS, MOCK_TRANSCRIPT_TURNS, mockPreparedPrompt } from "@/api/fixtures/agents";
import { MOCK_PR_TRIAGE, mockPrChecks } from "@/api/fixtures/prs";
import {
    EMPTY_ATTACH,
    MOCK_ATTENTION,
    MOCK_BUILD_LOG,
    MOCK_CMUX_LAYOUT,
    MOCK_CMUX_SNAPSHOT,
    MOCK_COMMANDS,
    MOCK_CONTAINERS,
    MOCK_DAEMON,
    MOCK_DISK_USAGE,
    MOCK_PORTS,
    MOCK_PRESETS,
    MOCK_QA,
    MOCK_RUNS,
    MOCK_TIMELINE,
    MOCK_TMUX,
    MOCK_TTYD,
    MOCK_USAGE,
    MOCK_USAGE_TOTALS,
    MOCK_VAULT,
    mockAddTodo,
    mockCompleteTodo,
    mockCreateCommand,
    mockDeleteCommand,
    mockHistory,
    mockNetStatus,
    mockProcessesRes,
    mockPulse,
    mockRemovePreset,
    mockSavePreset,
    mockTodosResult,
    mockWeather,
} from "@/api/fixtures/data";
import { MOCK_APPROVALS } from "@/api/fixtures/approvals";
import { MOCK_BRIEF } from "@/api/fixtures/brief";
import { MOCK_GATES } from "@/api/fixtures/gates";
import { MOCK_FORECAST, MOCK_GLANCE } from "@/api/fixtures/glance";
import { MOCK_LAUNCH } from "@/api/fixtures/launch";
import { MOCK_MEMOS } from "@/api/fixtures/memos";
import { MOCK_TIMESHEET } from "@/api/fixtures/timesheet";
import { MOCK_HEALTH, MOCK_WAKE } from "@/api/fixtures/wake";
import { MOCK_WATCHING } from "@/api/fixtures/watching";
import { fixtureAnswerForm, fixtureDraft, fixtureQueue, fixtureSendDrafts } from "@/api/fixtures/queue";

/**
 * The fixture wire: the third adapter at the client's fetch seam, beside the plain wire (expo fetch) and the sealed
 * wire (the managed tier's E2E fetch). When no Mac is connected the provider builds the REAL contract client over
 * this wire, so every screen and every feature test runs the real client's paths, parsing and stream demux; only
 * the bytes come from fixtures. A new endpoint needs one row here, never a mock method (M2b, D32).
 *
 * A path with no row answers 404 with the path in the body, so a missing fixture is a visible error instead of a
 * silent `{}`.
 */

export const FIXTURE_BASE_URL = "http://fixture.invalid";

/** How long a fixture answer takes, so loading states show as they would over a network. */
let latencyMs = 120;

/** Tests set 0, so a file of sequential fixture calls does not wait 120 ms on each. */
export function setFixtureLatency(ms: number): void {
    latencyMs = ms;
}

interface FixtureRequest {
    query: URLSearchParams;
    params: Record<string, string>;
    body: Record<string, unknown>;
}

interface FixtureRoute {
    method: EndpointMethod;
    /** A router pattern (`:name` for a segment), the same grammar as the endpoint table. */
    path: string;
    handle: (request: FixtureRequest) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number {
    return typeof value === "number" ? value : Number(value);
}

/** The `drafts` of a send body: the decisions the phone shows, each at the revision it showed. */
function draftsOf(value: unknown[]): { number: number; expectedRevision?: number }[] {
    return value.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null || !("number" in entry)) {
            return [];
        }

        const revision = "expectedRevision" in entry ? entry.expectedRevision : undefined;
        return [
            { number: numberOf(entry.number), ...(typeof revision === "number" ? { expectedRevision: revision } : {}) },
        ];
    });
}

/** A caller mistake the Mac would answer with 400; the client throws it as `<path> -> 400: <message>`. */
class FixtureRefusal extends Error {}

function refusing<T>(run: () => T): T {
    try {
        return run();
    } catch (err) {
        throw new FixtureRefusal(err instanceof Error ? err.message : String(err));
    }
}

const ROUTES: FixtureRoute[] = [
    // System and network.
    { method: "GET", path: paths.pulse(), handle: () => mockPulse() },
    {
        method: "POST",
        path: paths.liveSubscribe(),
        handle: ({ body }) => ({ ok: true, channels: Array.isArray(body.channels) ? body.channels : [] }),
    },
    {
        method: "GET",
        path: "/api/system/pulse/history",
        handle: ({ query }) => mockHistory(query.get("metric") ?? "cpu", numberOf(query.get("minutes") ?? 60)),
    },
    { method: "GET", path: paths.weather(), handle: () => mockWeather() },
    { method: "GET", path: paths.netStatus(), handle: () => mockNetStatus() },
    {
        method: "GET",
        path: "/api/processes",
        handle: ({ query }) => mockProcessesRes(query.get("sort") === "name" ? "name" : "rss"),
    },
    { method: "POST", path: paths.processesKill(), handle: () => ({ ok: true }) },
    { method: "GET", path: paths.ports(), handle: () => MOCK_PORTS },
    { method: "POST", path: paths.portsKill(), handle: () => ({ ok: true, killed: true }) },

    // tmux, presets, ttyd, cmux.
    { method: "GET", path: "/api/tmux/sessions", handle: () => MOCK_TMUX },
    {
        method: "POST",
        path: paths.tmuxCreate(),
        handle: ({ body }) => ({
            sessionName: text(body.name) || "mock",
            cwd: text(body.cwd) || "/",
            command: text(body.command) || "bash",
        }),
    },
    { method: "POST", path: paths.tmuxRename(), handle: ({ body }) => ({ sessionName: text(body.to) }) },
    { method: "GET", path: paths.tmuxPresets(), handle: () => ({ presets: MOCK_PRESETS }) },
    {
        method: "POST",
        path: paths.tmuxPresetSave(),
        handle: ({ body }) => ({ preset: mockSavePreset({ name: text(body.name), note: text(body.note) || undefined }) }),
    },
    {
        method: "POST",
        path: paths.tmuxPresetRestore(),
        handle: ({ body }) => ({
            result: { name: text(body.name), created: 1, skipped: 0, failed: 0, outcomes: [] },
        }),
    },
    { method: "DELETE", path: paths.tmuxPresetDelete(), handle: ({ body }) => mockRemovePreset(text(body.name)) },
    { method: "GET", path: paths.ttydList(), handle: () => MOCK_TTYD },
    { method: "POST", path: paths.ttydSpawn(), handle: () => ({ session: MOCK_TTYD.sessions[0] }) },
    { method: "POST", path: paths.ttydKill(), handle: () => ({ ok: true }) },
    { method: "POST", path: paths.ttydRename(), handle: () => ({ ok: true }) },
    { method: "GET", path: paths.cmuxSnapshot(), handle: () => MOCK_CMUX_SNAPSHOT },
    { method: "GET", path: paths.cmuxLayout(), handle: () => MOCK_CMUX_LAYOUT },
    { method: "POST", path: paths.cmuxCreateTerminal(), handle: () => ({ result: EMPTY_ATTACH }) },
    { method: "POST", path: paths.cmuxSendSession(), handle: () => ({ result: EMPTY_ATTACH }) },
    { method: "POST", path: paths.cmuxRemoveSession(), handle: () => ({ removed: 1 }) },
    { method: "POST", path: paths.cmuxAttach(), handle: () => ({ ok: true }) },
    { method: "POST", path: paths.cmuxRename(), handle: () => ({ ok: true }) },

    // Quick commands.
    { method: "GET", path: paths.commands(), handle: () => ({ commands: MOCK_COMMANDS }) },
    {
        method: "POST",
        path: paths.commands(),
        handle: ({ body }) => ({ command: mockCreateCommand({ label: text(body.label), command: text(body.command) }) }),
    },
    { method: "DELETE", path: paths.commands(), handle: ({ body }) => mockDeleteCommand(text(body.id)) },

    // Obsidian.
    { method: "GET", path: paths.obsidianTree(), handle: () => ({ entries: MOCK_VAULT }) },
    {
        method: "GET",
        path: "/api/obsidian/note",
        handle: ({ query }) => {
            const path = query.get("path") ?? "";
            return {
                source: `# ${path}\n\nMock note body — connect a device for the real vault.`,
                html: `<h1>${path}</h1><p>Mock note body — connect a device for the real vault.</p>`,
                publishedSlug: null,
            };
        },
    },
    {
        method: "POST",
        path: paths.obsidianMkdir(),
        handle: ({ body }) => ({ ok: true, relativeDir: text(body.relativeDir) }),
    },
    {
        method: "POST",
        path: paths.obsidianPublish(),
        handle: ({ body }) => ({
            note: { slug: "mock-note", vaultPath: text(body.path), publishedAt: new Date().toISOString() },
        }),
    },
    { method: "POST", path: paths.obsidianUnpublish(), handle: () => ({ remaining: [] }) },

    // QA log, attention, todos.
    { method: "GET", path: "/api/qa/log", handle: () => ({ entries: MOCK_QA }) },
    { method: "POST", path: paths.qaRead(), handle: () => ({ ok: true, updated: 0 }) },
    { method: "GET", path: paths.attention(), handle: () => MOCK_ATTENTION },
    {
        method: "GET",
        path: "/api/todos",
        handle: ({ query }) => mockTodosResult(query.get("includeCompleted") === "true"),
    },
    { method: "POST", path: paths.todoAdd(), handle: ({ body }) => mockAddTodo(text(body.title)) },
    { method: "POST", path: paths.todoComplete(), handle: ({ body }) => mockCompleteTodo(text(body.reminderId)) },
    { method: "POST", path: paths.todosRequestAccess(), handle: () => ({ granted: true }) },

    // Usage, daemon, containers, disk, timeline (the routes the generic `get` reaches).
    { method: "GET", path: paths.claudeUsage(), handle: () => [MOCK_USAGE] },
    { method: "GET", path: "/api/claude/usage/totals", handle: () => MOCK_USAGE_TOTALS },
    { method: "GET", path: "/api/claude/usage/history", handle: () => ({ series: [] }) },
    { method: "GET", path: paths.daemonStatus(), handle: () => MOCK_DAEMON },
    { method: "GET", path: "/api/daemon/runs", handle: () => MOCK_RUNS },
    // The static backlog seed is empty: the live tail (`buildLog.subscribe`) replays the fixture lines.
    { method: "GET", path: "/api/daemon/runs/log", handle: () => [] },
    { method: "GET", path: paths.containers(), handle: () => MOCK_CONTAINERS },
    { method: "GET", path: paths.diskUsage(), handle: () => MOCK_DISK_USAGE },
    { method: "GET", path: "/api/timeline", handle: () => MOCK_TIMELINE },

    // The Touch ID waiting card (F22); a raise answers "asked", since a fixture has no window to raise.
    { method: ENDPOINTS.gatewayGates.method, path: ENDPOINTS.gatewayGates.path, handle: () => MOCK_GATES },
    {
        method: ENDPOINTS.gatesRaise.method,
        path: ENDPOINTS.gatesRaise.path,
        handle: ({ body }) => ({ id: text(body.id), outcome: "asked", detail: "mock data: no window on a Mac" }),
    },

    // The glance (F18 badge) and the accounts forecast (F16).
    { method: ENDPOINTS.gatewayGlance.method, path: ENDPOINTS.gatewayGlance.path, handle: () => MOCK_GLANCE },
    { method: ENDPOINTS.gatewayForecast.method, path: ENDPOINTS.gatewayForecast.path, handle: () => MOCK_FORECAST },

    // Ping me when done (F15): the fixture keeps no watch.
    { method: ENDPOINTS.gatewayPings.method, path: ENDPOINTS.gatewayPings.path, handle: () => ({ watches: [] }) },
    {
        method: ENDPOINTS.pingWatch.method,
        path: ENDPOINTS.pingWatch.path,
        handle: ({ body }) => ({ watches: [{ key: text(body.key), label: null, since: "2026-11-04T15:00:00.000Z" }] }),
    },
    { method: ENDPOINTS.pingUnwatch.method, path: ENDPOINTS.pingUnwatch.path, handle: () => ({ watches: [] }) },

    // Approvals (F8); an answer is refused, since a fixture has no dialog to press keys in.
    { method: ENDPOINTS.gatewayApprovals.method, path: ENDPOINTS.gatewayApprovals.path, handle: () => MOCK_APPROVALS },
    {
        method: ENDPOINTS.approvalsAnswer.method,
        path: ENDPOINTS.approvalsAnswer.path,
        handle: ({ body }) => ({
            id: text(body.id),
            verdict: text(body.verdict),
            outcome: "refused",
            route: "none",
            detail: "mock data: no dialog on a Mac",
        }),
    },

    // The New agent sheet (F21); a start is refused, since a fixture has no cmux to open a workspace in.
    { method: ENDPOINTS.gatewayLaunch.method, path: ENDPOINTS.gatewayLaunch.path, handle: () => MOCK_LAUNCH },
    {
        method: ENDPOINTS.agentsNew.method,
        path: ENDPOINTS.agentsNew.path,
        handle: () => ({ started: false, name: null, workspace: null, cwd: null, error: "mock data: no Mac to start on" }),
    },

    // The morning brief (F29), as the daemon task stored it.
    { method: ENDPOINTS.gatewayBrief.method, path: ENDPOINTS.gatewayBrief.path, handle: () => MOCK_BRIEF },

    // The Friday timesheet (F27); a fill is refused, since a fixture has no Clarity to write.
    { method: ENDPOINTS.gatewayTimesheet.method, path: ENDPOINTS.gatewayTimesheet.path, handle: () => MOCK_TIMESHEET },
    {
        method: ENDPOINTS.timesheetFill.method,
        path: ENDPOINTS.timesheetFill.path,
        handle: () => ({ filled: false, written: 0, failed: 0, skipped: 0, error: "mock data: no Clarity to fill" }),
    },

    // Snap it to the agent (F24): the attach is refused, since a fixture has no shelf.
    {
        method: ENDPOINTS.snap.method,
        path: ENDPOINTS.snap.path,
        handle: () => ({ attached: false, draftKey: null, shelfId: null, error: "mock data: no shelf on a Mac" }),
    },

    // Memo to action (F28); an action is refused, since a fixture has no Reminders, vault or session.
    { method: ENDPOINTS.gatewayMemos.method, path: ENDPOINTS.gatewayMemos.path, handle: () => MOCK_MEMOS },
    {
        method: ENDPOINTS.memosAct.method,
        path: ENDPOINTS.memosAct.path,
        handle: ({ body }) => ({ id: text(body.id), action: text(body.action), ok: false, detail: "mock data: nothing to write" }),
    },

    // Send to my vault (F25): a clip and an append answer where they would have written, writing nothing.
    {
        method: ENDPOINTS.vaultClip.method,
        path: ENDPOINTS.vaultClip.path,
        handle: () => ({ kind: "page", note: "Inbox/2026-10-01 Phone inbox.md", title: "A page", error: null }),
    },
    {
        method: ENDPOINTS.vaultAppend.method,
        path: ENDPOINTS.vaultAppend.path,
        handle: () => ({ note: "Inbox/2026-10-01 Phone inbox.md" }),
    },

    // Wake my Mac (F26): the relay the phone keeps, and the health probe that answers once the Mac is awake.
    { method: ENDPOINTS.gatewayWake.method, path: ENDPOINTS.gatewayWake.path, handle: () => MOCK_WAKE },
    { method: ENDPOINTS.health.method, path: ENDPOINTS.health.path, handle: () => MOCK_HEALTH },

    // The Watching screen (F30); a mute answers that the fixture has no Monitor to write.
    { method: ENDPOINTS.gatewayWatching.method, path: ENDPOINTS.gatewayWatching.path, handle: () => MOCK_WATCHING },
    {
        method: ENDPOINTS.watchingMute.method,
        path: ENDPOINTS.watchingMute.path,
        handle: ({ body }) => ({
            source: text(body.source),
            id: text(body.id),
            muted: false,
            mutedUntil: null,
            detail: "mock data: no Monitor to mute",
        }),
    },

    // The agents board (F9) and its session view; a stop is refused, since a fixture has no process to end.
    { method: ENDPOINTS.gatewayBoard.method, path: ENDPOINTS.gatewayBoard.path, handle: () => MOCK_BOARD },
    {
        method: ENDPOINTS.gatewayTranscript.method,
        path: ENDPOINTS.gatewayTranscript.path,
        handle: () => ({ sessionId: MOCK_BOARD.sessions[0].sessionId, truncated: true, turns: MOCK_TRANSCRIPT_TURNS }),
    },
    {
        method: ENDPOINTS.agentsStop.method,
        path: ENDPOINTS.agentsStop.path,
        handle: ({ body }) => ({
            key: text(body.key),
            pid: numberOf(body.pid),
            stopped: false,
            signal: null,
            survivors: [],
            reason: "mock data: no process to stop",
        }),
    },

    // Saved prompts (F23): the list and one prepared for a session.
    { method: ENDPOINTS.gatewayPrompts.method, path: ENDPOINTS.gatewayPrompts.path, handle: () => MOCK_PROMPTS },
    {
        method: ENDPOINTS.gatewayPromptPrepare.method,
        path: ENDPOINTS.gatewayPromptPrepare.path,
        handle: ({ query }) => mockPreparedPrompt(query.get("name") ?? "", query.get("session")),
    },

    // PR triage (F20): the list, one PR's checks; a fix and a merge are refused, since a fixture has no Mac.
    { method: ENDPOINTS.gatewayPrs.method, path: ENDPOINTS.gatewayPrs.path, handle: () => MOCK_PR_TRIAGE },
    {
        method: ENDPOINTS.gatewayPrChecks.method,
        path: ENDPOINTS.gatewayPrChecks.path,
        handle: ({ query }) => mockPrChecks(query.get("url") ?? ""),
    },
    {
        method: ENDPOINTS.prsFix.method,
        path: ENDPOINTS.prsFix.path,
        handle: ({ body }) => ({
            url: text(body.url),
            kind: body.kind === "check" ? "check" : "threads",
            sent: false,
            owner: null,
            file: null,
            error: "mock data: no session to hand the PR to",
        }),
    },
    {
        method: ENDPOINTS.prsMerge.method,
        path: ENDPOINTS.prsMerge.path,
        handle: ({ body }) => ({
            url: text(body.url),
            method: body.method === "squash" ? "squash" : "rebase",
            merged: false,
            detail: "mock data: nothing was merged",
        }),
    },

    // The steer composer and Esc (F10, F19): refused, since a fixture has no session to reach.
    {
        method: ENDPOINTS.agentsSend.method,
        path: ENDPOINTS.agentsSend.path,
        handle: ({ body }) => ({
            key: text(body.key),
            outcome: "refused",
            timing: text(body.timing) || "now",
            route: "none",
            detail: "mock data: no session to reach",
        }),
    },
    {
        method: ENDPOINTS.agentsVoice.method,
        path: ENDPOINTS.agentsVoice.path,
        handle: () => ({
            path: "/mock/voice/clip.m4a",
            bytes: 0,
            sha256: "",
            text: "mock data: run the failing test again and tell me what changed",
            provider: "mock",
            model: "mock",
        }),
    },
    {
        method: ENDPOINTS.agentsInterrupt.method,
        path: ENDPOINTS.agentsInterrupt.path,
        handle: ({ body }) => ({ key: text(body.key), outcome: "refused", route: "none", detail: "mock data: no pane" }),
    },

    // The answer queue (F6): the waiting set and its writes.
    { method: ENDPOINTS.qaWaiting.method, path: ENDPOINTS.qaWaiting.path, handle: () => fixtureQueue() },
    {
        method: ENDPOINTS.qaDecisionsDraft.method,
        path: ENDPOINTS.qaDecisionsDraft.path,
        handle: ({ body }) =>
            refusing(() =>
                fixtureDraft({
                    session: text(body.session),
                    number: numberOf(body.number),
                    // An empty string clears, as on the Mac; only an absent field keeps the staged value.
                    option: typeof body.option === "string" ? body.option : undefined,
                    text: typeof body.text === "string" ? body.text : undefined,
                    expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
                })
            ),
    },
    {
        method: ENDPOINTS.qaDecisionsSendDrafts.method,
        path: ENDPOINTS.qaDecisionsSendDrafts.path,
        handle: ({ body }) =>
            refusing(() =>
                fixtureSendDrafts({
                    session: text(body.session),
                    ...(Array.isArray(body.drafts) ? { drafts: draftsOf(body.drafts) } : {}),
                })
            ),
    },
    {
        method: ENDPOINTS.qaPendingAnswer.method,
        path: ENDPOINTS.qaPendingAnswer.path,
        handle: ({ params, body }) =>
            refusing(() =>
                fixtureAnswerForm(
                    params.id ?? "",
                    (Array.isArray(body.answers) ? body.answers : []).filter(isRecord).map((answer) => ({
                        itemId: text(answer.itemId),
                        ...(Array.isArray(answer.selectedChoices)
                            ? { selectedChoices: answer.selectedChoices.map(text) }
                            : {}),
                        ...(typeof answer.freeText === "string" ? { freeText: answer.freeText } : {}),
                    }))
                )
            ),
    },
];

/** The `:name` segments of a pattern filled from a concrete path. */
function paramsOf(pattern: string, pathname: string): Record<string, string> {
    const want = pattern.split("/");
    const have = pathname.split("/");
    const params: Record<string, string> = {};

    want.forEach((part, index) => {
        if (part.startsWith(":")) {
            params[part.slice(1)] = decodeURIComponent(have[index] ?? "");
        }
    });

    return params;
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
    if (typeof init?.body !== "string" || init.body.length === 0) {
        return {};
    }

    const parsed: unknown = SafeJSON.parse(init.body, { strict: true });
    return isRecord(parsed) ? parsed : {};
}

function respond(status: number, value: unknown): Promise<Response> {
    return new Promise((resolve) => {
        setTimeout(
            () =>
                resolve(
                    new Response(SafeJSON.stringify(value), {
                        status,
                        headers: { "Content-Type": "application/json" },
                    })
                ),
            latencyMs
        );
    });
}

/** The fetch of the fixture wire: routes a request to its row, as the Mac's router would. */
export function fixtureFetch(url: string, init?: RequestInit): Promise<Response> {
    const parsed = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const route = ROUTES.find((entry) => entry.method === method && pathMatches(entry.path, parsed.pathname));

    if (!route) {
        return respond(404, { error: `no fixture for ${method} ${parsed.pathname}` });
    }

    try {
        const value = route.handle({
            query: parsed.searchParams,
            params: paramsOf(route.path, parsed.pathname),
            body: bodyOf(init),
        });
        return respond(200, value);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return respond(err instanceof FixtureRefusal ? 400 : 500, { error: message });
    }
}

/** A replay of fixture frames over the EventSource seam, with the stream's own frame tags. */
function replay(frames: { delayMs: number; data: unknown }[]): EventSourceLike {
    const source: EventSourceLike = { onmessage: null, onopen: null, onerror: null, close: () => undefined };
    const timers = frames.map((frame) =>
        setTimeout(() => source.onmessage?.({ data: SafeJSON.stringify(frame.data) }), frame.delayMs)
    );
    const opened = setTimeout(() => source.onopen?.({}), 0);
    source.close = () => {
        clearTimeout(opened);
        timers.forEach(clearTimeout);
    };

    return source;
}

/**
 * The streams of the fixture wire. The QA stream sends a tagged `qa` frame (and a `pending` frame the real demux must
 * drop), so the client's demux runs under fixtures too; the build-log tail replays its lines.
 */
export function fixtureEventSource(url: string): EventSourceLike {
    const { pathname } = new URL(url);

    if (pathname === QA_STREAM_PATH) {
        return replay([
            { delayMs: 400, data: { type: "pending", id: "ask_fixture" } },
            { delayMs: 800, data: { type: "qa", ...MOCK_QA[0] } },
        ]);
    }

    if (pathname === paths.live()) {
        // The live stream says hello like the Mac's, then sends the pulse fixture when pulse is asked for.
        const channels = (new URL(url).searchParams.get("channels") ?? "").split(",").filter(Boolean);
        return replay([
            { delayMs: 0, data: { v: 1, channel: "system", type: "hello", payload: { connId: "fixture", channels } } },
            ...(channels.includes("pulse")
                ? [{ delayMs: 50, data: { v: 1, channel: "pulse", type: "snapshot", payload: mockPulse() } }]
                : []),
        ]);
    }

    if (pathname === "/api/daemon/runs/tail") {
        return replay(MOCK_BUILD_LOG.map((entry, index) => ({ delayMs: 400 * (index + 1), data: entry })));
    }

    return replay([]);
}

/** The real contract client over the fixture wire: what the app uses while no Mac is connected. */
export function createFixtureClient(): DashboardClient {
    return createDashboardClient({
        baseUrl: FIXTURE_BASE_URL,
        fetch: fixtureFetch,
        eventSourceFactory: fixtureEventSource,
    });
}

export const fixtureDashboardClient: DashboardClient = createFixtureClient();
