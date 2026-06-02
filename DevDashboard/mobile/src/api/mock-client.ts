import type {
    AccountUsage,
    AttentionRes,
    BuildLogSubscription,
    ClassifiedLogEntry,
    ContainersResult,
    DaemonOverview,
    DashboardClient,
    DiskUsageResult,
    EnrichedQaEntry,
    KillPortResult,
    NetStatusRes,
    PortsResult,
    ProcessInfo,
    ProcessSort,
    ProcessesRes,
    PublishedNote,
    PulseHistoryRes,
    PulseRes,
    QaSubscription,
    RunSummary,
    SavedCommand,
    TimelineEvent,
    TmuxPresetSummary,
    TmuxSessionsRes,
    TodosResult,
    VaultEntry,
    WeatherRes,
} from "@dd/contract";
import { paths } from "@dd/contract";

/**
 * A `DashboardClient`-shaped stand-in that returns believable FIXTURES instead of hitting a
 * device. The `ClientProvider` injects this whenever no transport is connected (D32: mock↔real is
 * swapped at the CLIENT, never at the hooks).
 *
 * COMPREHENSIVE BY DESIGN: every method the contract exposes — system / weather / tmux / ttyd /
 * cmux / obsidian / qa (incl. the SSE `subscribe`) AND the generic `get`/`post` escape hatch used
 * for the deferred claude/daemon/containers/todos routes — returns realistic data. Parallel
 * feature agents CONSUME this mock without editing it, so their endpoints must already be covered
 * here. Do NOT trim it to "just what Pulse needs": that would force every other feature to touch
 * this shared file (merge-conflict magnet). Add fixtures for NEW endpoints here as the contract
 * grows; never special-case per screen.
 *
 * Everything here is FAKE. The provider exposes `isMock` so screens can show a "mock data" badge.
 * The const is typed as `DashboardClient`, so the compiler enforces parity with the real client.
 */

/** Tiny async delay so the mock feels like a network call (and loading states are exercised). */
function delay<T>(value: T, ms = 120): Promise<T> {
    return new Promise((resolve) => {
        setTimeout(() => resolve(value), ms);
    });
}

/** A slowly-wandering value in [min, max], seeded off the clock so successive polls differ. */
function wander(base: number, amplitude: number, periodMs: number, min = 0, max = 100): number {
    const phase = (Date.now() % periodMs) / periodMs;
    const value = base + amplitude * Math.sin(phase * Math.PI * 2);
    return Math.min(max, Math.max(min, Math.round(value * 10) / 10));
}

const GB = 1024 ** 3;
const MB = 1024 * 1024;
const MEM_TOTAL = 32 * GB;
const SWAP_TOTAL = 4 * GB;
const DISK_TOTAL = 994 * GB;

const MOCK_PROCESSES = [
    { pid: 4821, name: "node (metro)", rssBytes: 1.8 * GB },
    { pid: 1390, name: "Code Helper (Plugin)", rssBytes: 1.2 * GB },
    { pid: 9920, name: "bun", rssBytes: 880 * MB },
    { pid: 277, name: "WindowServer", rssBytes: 640 * MB },
    { pid: 5512, name: "tmux: server", rssBytes: 96 * MB },
];

/** Full ProcessInfo fixtures for the Process Monitor surface (5 fields incl. uptime + cpu). */
const MOCK_PROCESSES_FULL: ProcessInfo[] = [
    { pid: 4821, name: "node (metro)", rssBytes: 1.8 * GB, uptimeMs: 5_400_000, cpuPct: 18.2 },
    { pid: 1390, name: "Code Helper (Plugin)", rssBytes: 1.2 * GB, uptimeMs: 9_000_000, cpuPct: 4.1 },
    { pid: 9920, name: "bun", rssBytes: 880 * MB, uptimeMs: 600_000, cpuPct: 61.5 },
    { pid: 277, name: "WindowServer", rssBytes: 640 * MB, uptimeMs: 72_000_000, cpuPct: 2.0 },
    { pid: 5512, name: "tmux: server", rssBytes: 96 * MB, uptimeMs: 36_000_000, cpuPct: 0.1 },
    { pid: 8123, name: "Activity Monitor", rssBytes: 120 * MB, uptimeMs: 120_000, cpuPct: 0.4 },
];

/** Mirrors the backend `sortProcesses`: rss desc (ties → pid asc) / name asc (ties → pid asc). */
function sortMock(list: ProcessInfo[], sort: ProcessSort): ProcessInfo[] {
    const copy = [...list];

    if (sort === "name") {
        copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.pid - b.pid);
    } else {
        copy.sort((a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid);
    }

    return copy;
}

function mockProcessesRes(sort: ProcessSort): ProcessesRes {
    return { sort, processes: sortMock(MOCK_PROCESSES_FULL, sort) };
}

function mockPulse(): PulseRes {
    const cpuPct = wander(34, 26, 9000);
    const memFreePct = wander(41, 12, 17000, 5, 95);
    const swapUsed = wander(0.9, 0.6, 23000, 0, 3.5) * GB;
    return {
        cpuPct,
        memUsedBytes: MEM_TOTAL * (1 - memFreePct / 100),
        memTotalBytes: MEM_TOTAL,
        memFreePct,
        swapUsedBytes: swapUsed,
        swapTotalBytes: SWAP_TOTAL,
        batteryPct: Math.round(wander(76, 8, 600000, 0, 100)),
        batteryState: "discharging",
        diskFreeBytes: 212 * GB,
        diskTotalBytes: DISK_TOTAL,
        wifiSsid: "Foltyn-5G (mock)",
        publicIp: "203.0.113.7",
        topProcesses: MOCK_PROCESSES,
        capturedAt: new Date().toISOString(),
    };
}

function mockNetStatus(): NetStatusRes {
    // A believable healthy LAN link: ~40-90ms wander, real-looking SSID + IP. Mirrors mockPulse's
    // network fields so the network-status screen reads consistently with Pulse under the mock.
    const latencyMs = Math.round(wander(60, 30, 11000, 8, 400));
    const quality = latencyMs <= 150 ? "healthy" : "degraded";
    return {
        transport: "lan",
        latencyMs,
        quality,
        ssid: "Foltyn-5G (mock)",
        publicIp: "203.0.113.7",
    };
}

/** Synthesize a window of points ending now, one per ~30 s, wandering around a per-metric base. */
function mockHistory(metric: string, minutes: number): PulseHistoryRes {
    const stepMs = 30_000;
    const count = Math.min(240, Math.max(8, Math.floor((minutes * 60_000) / stepMs)));
    const now = Date.now();
    const base = metric === "cpu" ? 32 : metric === "swap" ? 18 : 44;
    const amp = metric === "cpu" ? 22 : metric === "swap" ? 10 : 14;
    const points = Array.from({ length: count }, (_, i) => {
        const tsMs = now - (count - 1 - i) * stepMs;
        const phase = (tsMs % 90_000) / 90_000;
        const value = Math.min(100, Math.max(0, Math.round((base + amp * Math.sin(phase * Math.PI * 2)) * 10) / 10));
        return { ts: new Date(tsMs).toISOString(), value };
    });
    return { metric, points };
}

function mockWeather(): WeatherRes {
    const sunrise = new Date();
    sunrise.setHours(5, 41, 0, 0);
    const sunset = new Date();
    sunset.setHours(20, 12, 0, 0);
    return {
        tempC: wander(18, 4, 600000, -10, 40),
        weatherCode: 2,
        description: "Partly cloudy",
        sunrise: sunrise.toISOString(),
        sunset: sunset.toISOString(),
        label: "Prague (mock)",
        fetchedAt: new Date().toISOString(),
    };
}

const MOCK_TMUX: TmuxSessionsRes = {
    sessions: [
        { name: "dev", attached: 1, windows: 3, ttydTabIds: ["ttyd-1"], canAttachInTtyd: true, cmuxSurfaces: [], inCmux: false },
        { name: "agents", attached: 0, windows: 5, ttydTabIds: [], canAttachInTtyd: true, cmuxSurfaces: [], inCmux: true },
        { name: "logs", attached: 0, windows: 1, ttydTabIds: [], canAttachInTtyd: false, cmuxSurfaces: [], inCmux: false },
    ],
};

const MOCK_TTYD = {
    sessions: [
        {
            id: "ttyd-1",
            port: 7681,
            command: "bash",
            cwd: "/Users/dev/project",
            pid: 4821,
            startedAt: new Date(Date.now() - 1_800_000).toISOString(),
            tmuxSessionName: "dev",
            // Manual name set — must win over the live `lastCommand` (auto-name never overwrites it).
            name: "dev shell",
            lastCommand: "claude",
        },
        {
            id: "ttyd-2",
            port: 7682,
            command: "bun dev",
            cwd: "/Users/dev/project/mobile",
            pid: 9920,
            startedAt: new Date(Date.now() - 600_000).toISOString(),
            name: "metro :7682",
        },
        {
            id: "ttyd-3",
            port: 7683,
            command: "/bin/zsh",
            cwd: "/Users/dev/project/api",
            pid: 10234,
            startedAt: new Date(Date.now() - 120_000).toISOString(),
            tmuxSessionName: "api",
            // No manual name → auto-names from the live command ("vim").
            lastCommand: "vim",
        },
    ],
};

const EMPTY_ATTACH = { workspaceId: "ws-1", paneId: "pane-1", surfaceId: "surf-1", tmuxSessionName: "dev" };

const MOCK_CMUX_SNAPSHOT = {
    snapshot: {
        fetchedAt: new Date().toISOString(),
        available: true,
        workspaces: [{ id: "ws-1", name: "main" }],
        panes: [
            {
                id: "pane-1",
                workspaceId: "ws-1",
                title: "editor",
                active: true,
                surfaceCount: 1,
                surfaces: [{ id: "surf-1", title: "dev", type: "terminal", index: 0, selected: true, active: true }],
                // The pane's terminal surface (title "dev") resolves to ttyd-1 — tapping opens it as a
                // real terminal (the enrichPanesWithTtyd join), not just a native-cmux focus.
                ttydSessionId: "ttyd-1",
            },
        ],
    },
};

const MOCK_CMUX_LAYOUT = {
    layout: {
        fetchedAt: new Date().toISOString(),
        available: true,
        windows: [
            {
                id: "win-1",
                index: 0,
                visible: true,
                workspaces: [
                    {
                        id: "ws-1",
                        name: "main",
                        selected: true,
                        panes: [
                            {
                                id: "pane-1",
                                title: "editor",
                                active: true,
                                surfaces: [{ id: "surf-1", title: "nvim", type: "terminal", selected: true }],
                            },
                        ],
                    },
                ],
            },
        ],
    },
};

const MOCK_VAULT: VaultEntry[] = [
    {
        name: "Projects",
        relativePath: "Projects",
        isDirectory: true,
        children: [
            { name: "DevDashboard.md", relativePath: "Projects/DevDashboard.md", isDirectory: false },
            { name: "Roadmap.md", relativePath: "Projects/Roadmap.md", isDirectory: false },
        ],
    },
    { name: "Daily.md", relativePath: "Daily.md", isDirectory: false },
];

const MOCK_QA: EnrichedQaEntry[] = [
    {
        questionHtml: "<p>Why victory-native XL over react-native-graph? (mock)</p>",
        answerHtml: "<p>Skia GPU canvas, area + sparkline in one lib, behind a swappable <code>MetricChart</code>.</p>",
        answerHtmlPreview: "Skia GPU canvas, area + sparkline in one lib…",
    },
    {
        questionHtml: "<p>How is mock vs real swapped? (mock)</p>",
        answerHtml: "<p>At the <code>ClientProvider</code> — the hooks never know which client they talk to.</p>",
        answerHtmlPreview: "At the ClientProvider — the hooks never know…",
    },
];

/** Two attention items: an unread agent question (mark-read flow) + a live agent session that
 *  hands off to the real `ttyd-1` mock terminal (deep-link open flow). */
const MOCK_ATTENTION: AttentionRes = {
    items: [
        {
            id: "qa:mock-1",
            kind: "agent-question",
            title: "Approve the DB migration? (mock)",
            subtitle: "GenesisTools",
            ts: Date.now() - 120_000,
            deepLink: { kind: "qa", qaId: "mock-1" },
        },
        {
            id: "ttyd:ttyd-1",
            kind: "agent-session",
            title: "dev shell",
            subtitle: "claude · project",
            ts: Date.now() - 1_800_000,
            deepLink: { kind: "terminal", ttydTabId: "ttyd-1" },
        },
    ],
    count: 2,
};

const MOCK_USAGE: AccountUsage = {
    accountName: "mock-account",
    label: "Mock (no device connected)",
};

const MOCK_DAEMON: DaemonOverview = {
    status: { installed: true, running: true, pid: 4242 },
    tasks: [],
};

/** One recorded run so the build-log-tail run picker has a tappable row under the mock (the daemon
 *  screen's runs list also renders this instead of empty). The `logFile` is ignored by the mock
 *  `buildLog.subscribe`, which always replays MOCK_BUILD_LOG. */
const MOCK_RUNS: RunSummary[] = [
    {
        taskName: "sync",
        runId: "mock-run",
        logFile: "sync/mock.jsonl",
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        exitCode: null,
        duration_ms: null,
        attempt: 1,
    },
];

/** A short scripted tail so the live viewer shows life offline — including ONE error line so the
 *  highlight + jump-to-error FAB are demonstrable under the mock. */
const MOCK_BUILD_LOG: ClassifiedLogEntry[] = [
    {
        type: "meta",
        taskName: "sync",
        command: "bun run sync",
        runId: "mock-run",
        attempt: 1,
        startedAt: new Date().toISOString(),
        cls: "info",
    },
    { type: "stdout", ts: new Date().toISOString(), data: "Compiling 42 modules…", cls: "info" },
    { type: "stdout", ts: new Date().toISOString(), data: "warning: deprecated API used", cls: "warn" },
    { type: "stderr", ts: new Date().toISOString(), data: "Error: cannot find module 'foo'", cls: "error" },
    { type: "exit", ts: new Date().toISOString(), code: 1, duration_ms: 4200, cls: "error" },
];

const MOCK_CONTAINERS: ContainersResult = {
    dockerAvailable: false,
    containers: [],
};

const MOCK_DISK_USAGE: DiskUsageResult = {
    available: true,
    scannedAt: new Date().toISOString(),
    // Pre-sorted bytes-desc (the contract). The mobile screen relies on this order for the rank.
    entries: [
        { path: "/Users/dev/project/node_modules", label: "project/node_modules", bytes: 2.2 * GB },
        { path: "/Users/dev/Library/Developer/Xcode/DerivedData", label: "~/…/DerivedData", bytes: 1.4 * GB },
        { path: "/Users/dev/Library/Caches", label: "~/Library/Caches", bytes: 880 * MB },
        { path: "/Users/dev/project/ios/build", label: "ios/build", bytes: 512 * MB },
        { path: "/Users/dev/.bun/install/cache", label: "~/.bun/install/cache", bytes: 240 * MB },
    ],
};

const MOCK_PORTS: PortsResult = {
    lsofAvailable: true,
    ports: [
        { port: 3000, pid: 4821, command: "node", address: "127.0.0.1", proto: "tcp4" },
        { port: 5173, pid: 9920, command: "bun", address: "127.0.0.1", proto: "tcp4" },
        { port: 8787, pid: 1307, command: "node", address: "*", proto: "tcp4" },
    ],
};

const MOCK_TODO_LISTS: TodosResult["lists"] = [
    { identifier: "list-gt", title: "GenesisTools", color: "#34d399", source: "iCloud" },
];

/** Mutable so the mock's add/complete are STATEFUL — the "complete removes a row" / "add appears"
 *  Appium + unit assertions need the list ↔ mutation round-trip to be real, not a no-op. */
let MOCK_TODO_REMINDERS: TodosResult["reminders"] = [
    {
        identifier: "rem-1",
        title: "Ship reminders-todos feature",
        is_completed: false,
        priority: 0,
        list_identifier: "list-gt",
        list_title: "GenesisTools",
        has_alarms: false,
        alarms: [],
        is_flagged: false,
    },
    {
        identifier: "rem-2",
        title: "Review the mobile PR",
        is_completed: false,
        priority: 1,
        due_date: new Date(Date.now() + 86_400_000).toISOString(),
        list_identifier: "list-gt",
        list_title: "GenesisTools",
        has_alarms: false,
        alarms: [],
        is_flagged: false,
    },
];

let mockTodoSeq = 0;

function mockTodosResult(includeCompleted: boolean): TodosResult {
    return {
        lists: MOCK_TODO_LISTS,
        reminders: includeCompleted ? MOCK_TODO_REMINDERS : MOCK_TODO_REMINDERS.filter((r) => !r.is_completed),
    };
}

function mockAddTodo(title: string): { reminderId: string } {
    const reminderId = `rem-mock-${++mockTodoSeq}`;
    MOCK_TODO_REMINDERS = [
        ...MOCK_TODO_REMINDERS,
        {
            identifier: reminderId,
            title,
            is_completed: false,
            priority: 0,
            list_identifier: "list-gt",
            list_title: "GenesisTools",
            has_alarms: false,
            alarms: [],
            is_flagged: false,
        },
    ];
    return { reminderId };
}

function mockCompleteTodo(reminderId: string): { ok: true } {
    MOCK_TODO_REMINDERS = MOCK_TODO_REMINDERS.filter((r) => r.identifier !== reminderId);
    return { ok: true };
}

/** Activity-timeline fixture — relative-to-now so successive renders stay "today" and span hours. */
const MOCK_TIMELINE: TimelineEvent[] = [
    {
        id: "terminal-ttyd-2",
        type: "terminal",
        ts: Date.now() - 600_000,
        title: "metro :7682",
        subtitle: "/Users/dev/project/mobile",
        command: "bun dev",
        cwd: "/Users/dev/project/mobile",
    },
    {
        id: "qa-mock-1",
        type: "qa",
        ts: Date.now() - 1_500_000,
        title: "Why merge in a pure lib? (mock)",
        subtitle: "GenesisTools",
        tag: "action",
        project: "GenesisTools",
    },
    {
        id: "run-sync-1",
        type: "run",
        ts: Date.now() - 3_600_000,
        title: "sync",
        subtitle: "exit 0",
        runId: "sync-1",
        exitCode: 0,
        durationMs: 1200,
    },
    {
        id: "run-build-9",
        type: "run",
        ts: Date.now() - 7_200_000,
        title: "build",
        subtitle: "exit 2",
        runId: "build-9",
        exitCode: 2,
        durationMs: 48200,
    },
];

const PRESET_DIR = "~/.genesis-tools/cmux/tmux-presets";

/** Mutable so the mock's save/remove are STATEFUL — the "capture adds a row" / "delete drops a row"
 *  Appium + unit assertions need the list ↔ mutation round-trip to be real, not a no-op. */
let MOCK_PRESETS: TmuxPresetSummary[] = [
    {
        name: "morning-dev",
        capturedAt: new Date(Date.now() - 3_600_000).toISOString(),
        sessions: 3,
        windows: 7,
        panes: 12,
        bytes: 4096,
        note: "editor + agents + logs",
        path: `${PRESET_DIR}/morning-dev.json`,
    },
    {
        name: "release",
        capturedAt: new Date(Date.now() - 86_400_000).toISOString(),
        sessions: 1,
        windows: 2,
        panes: 2,
        bytes: 1024,
        note: undefined,
        path: `${PRESET_DIR}/release.json`,
    },
];

function mockSavePreset(body: { name: string; note?: string }): TmuxPresetSummary {
    const preset: TmuxPresetSummary = {
        name: body.name,
        capturedAt: new Date().toISOString(),
        sessions: 1,
        windows: 1,
        panes: 1,
        bytes: 512,
        note: body.note,
        path: `${PRESET_DIR}/${body.name}.json`,
    };
    // force-overwrite a same-named preset (mirrors the backend `force:true` save semantics).
    MOCK_PRESETS = [...MOCK_PRESETS.filter((p) => p.name !== body.name), preset];
    return preset;
}

function mockRemovePreset(name: string): { removed: boolean } {
    const before = MOCK_PRESETS.length;
    MOCK_PRESETS = MOCK_PRESETS.filter((p) => p.name !== name);
    return { removed: MOCK_PRESETS.length < before };
}

/** Quick-commands snippet library — mutable so create/delete round-trip in the mock (the Appium
 *  persist-across-refetch assertion needs `list()` to reflect a prior `create()`). */
let MOCK_COMMANDS: SavedCommand[] = [
    { id: "cmd-tests", label: "Run tests", command: "bun test" },
    { id: "cmd-status", label: "Git status", command: "git status" },
    { id: "cmd-dev", label: "Restart dev server", command: "bun dev" },
];

function mockCreateCommand(body: { label: string; command: string }): SavedCommand {
    const command: SavedCommand = {
        id: `cmd-mock-${Date.now().toString(36)}`,
        label: body.label,
        command: body.command,
    };
    MOCK_COMMANDS = [...MOCK_COMMANDS, command];
    return command;
}

function mockDeleteCommand(id: string): { removed: number } {
    const before = MOCK_COMMANDS.length;
    MOCK_COMMANDS = MOCK_COMMANDS.filter((c) => c.id !== id);
    return { removed: before - MOCK_COMMANDS.length };
}

/**
 * Generic escape-hatch responder. The real `get<T>`/`post<T>` are generic, so the mock cannot
 * statically know `T` — it path-switches on the known deferred routes and returns a plausible
 * top-level fixture, cast once to `T` (the only unavoidable cast, inherent to the generic
 * signature). Unknown paths return `{}` rather than throwing, so a not-yet-mocked route degrades
 * to an empty render instead of a crash. Real-typed methods (system/tmux/…) never go through here.
 */
function escapeHatch<T>(path: string): Promise<T> {
    if (path.startsWith(paths.claudeUsage())) {
        // NB: `/api/claude/usage` is a prefix of `/api/claude/usage/history`, so the history route
        // also lands here and gets the account-usage fixture (shape ≈ but not the history result).
        // Both are deferred (no v1 screen); a claude-usage feature agent should add a `/history`
        // branch returning a `MultiBucketHistoryResult` fixture before this line.
        return delay([MOCK_USAGE] as unknown as T);
    }

    if (path.startsWith(paths.daemonStatus())) {
        return delay(MOCK_DAEMON as unknown as T);
    }

    if (path.startsWith("/api/daemon/runs/log")) {
        // The static run-log backlog seed. No mock log fixture — return [] so the live SSE tail
        // (`buildLog.subscribe`, which replays MOCK_BUILD_LOG) is the sole source of mock lines.
        return delay([] as unknown as T);
    }

    if (path.startsWith(paths.daemonRuns())) {
        // Serves both the daemon screen's runs list AND the build-log-tail run picker. (Checked AFTER
        // `/api/daemon/runs/log` so the backlog seed isn't shadowed.) The live tail is the SSE
        // `buildLog.subscribe` seam, NOT this escape hatch.
        return delay(MOCK_RUNS as unknown as T);
    }

    if (path.startsWith(paths.containers())) {
        return delay(MOCK_CONTAINERS as unknown as T);
    }

    if (path.startsWith(paths.diskUsage())) {
        return delay(MOCK_DISK_USAGE as unknown as T);
    }

    if (path.startsWith("/api/todos")) {
        const includeCompleted = path.includes("includeCompleted=true");
        return delay(mockTodosResult(includeCompleted) as unknown as T);
    }

    if (path.startsWith(paths.portsKill())) {
        return delay({ ok: true, killed: true } as KillPortResult as unknown as T);
    }

    if (path.startsWith(paths.ports())) {
        return delay(MOCK_PORTS as unknown as T);
    }

    if (path.startsWith(paths.processesKill())) {
        return delay({ ok: true } as unknown as T);
    }

    if (path.startsWith("/api/processes")) {
        const sort: ProcessSort = path.includes("sort=name") ? "name" : "rss";
        return delay(mockProcessesRes(sort) as unknown as T);
    }

    if (path.startsWith(paths.netStatus())) {
        return delay(mockNetStatus() as unknown as T);
    }

    if (path.startsWith("/api/timeline")) {
        return delay(MOCK_TIMELINE as unknown as T);
    }

    return delay({} as T);
}

export const mockDashboardClient: DashboardClient = {
    get: <T>(path: string) => escapeHatch<T>(path),
    post: <T>(path: string, _body: unknown) => escapeHatch<T>(path),

    system: {
        pulse: () => delay(mockPulse()),
        pulseHistory: (metric, minutes) => delay(mockHistory(metric, minutes)),
    },
    weather: () => delay(mockWeather()),
    processes: {
        list: (sort = "rss") => delay(mockProcessesRes(sort)),
        kill: () => delay({ ok: true }),
    },
    ports: {
        list: () => delay(MOCK_PORTS),
        kill: () => delay({ ok: true, killed: true } as KillPortResult),
    },
    tmux: {
        sessions: () => delay(MOCK_TMUX),
        create: (body = {}) =>
            delay({ sessionName: body.name ?? "mock", cwd: body.cwd ?? "/", command: body.command ?? "bash" }),
        rename: (body) => delay({ sessionName: body.to }),
    },
    presets: {
        list: () => delay({ presets: MOCK_PRESETS }),
        save: (body) => delay({ preset: mockSavePreset(body) }),
        restore: (name) => delay({ result: { name, created: 1, skipped: 0, failed: 0, outcomes: [] } }),
        remove: (name) => delay(mockRemovePreset(name)),
    },
    ttyd: {
        list: () => delay(MOCK_TTYD),
        spawn: () => delay({ session: MOCK_TTYD.sessions[0] }),
        kill: () => delay({ ok: true }),
        rename: () => delay({ ok: true }),
    },
    cmux: {
        snapshot: () => delay(MOCK_CMUX_SNAPSHOT),
        layout: () => delay(MOCK_CMUX_LAYOUT),
        createTerminal: () => delay({ result: EMPTY_ATTACH }),
        sendSession: () => delay({ result: EMPTY_ATTACH }),
        removeSession: () => delay({ removed: 1 }),
        attach: () => delay({ ok: true }),
        rename: () => delay({ ok: true }),
    },
    commands: {
        list: () => delay({ commands: MOCK_COMMANDS }),
        create: (body) => delay({ command: mockCreateCommand(body) }),
        delete: (id) => delay(mockDeleteCommand(id)),
    },
    obsidian: {
        tree: () => delay({ entries: MOCK_VAULT }),
        note: (path) =>
            delay({
                source: `# ${path}\n\nMock note body — connect a device for the real vault.`,
                html: `<h1>${path}</h1><p>Mock note body — connect a device for the real vault.</p>`,
                publishedSlug: null,
            }),
        mkdir: (relativeDir) => delay({ ok: true, relativeDir }),
        publish: (path) =>
            delay({ note: { slug: "mock-note", vaultPath: path, publishedAt: new Date().toISOString() } }),
        unpublish: () => delay({ remaining: [] as PublishedNote[] }),
    },
    qa: {
        log: () => delay({ entries: MOCK_QA }),
        read: () => delay({ ok: true, updated: 0 }),
        subscribe: (onEntry: (entry: EnrichedQaEntry) => void): QaSubscription => {
            // Emit one fixture shortly after subscribing so a QA stream UI shows life under the mock.
            const timer = setTimeout(() => onEntry(MOCK_QA[0]), 800);
            return { close: () => clearTimeout(timer) };
        },
    },
    buildLog: {
        subscribe: (_logFile: string, onEntry: (entry: ClassifiedLogEntry) => void): BuildLogSubscription => {
            // Replay the fixture at ~400ms intervals so loading / auto-scroll / error highlight all show.
            const timers = MOCK_BUILD_LOG.map((entry, i) => setTimeout(() => onEntry(entry), 400 * (i + 1)));
            return { close: () => timers.forEach(clearTimeout) };
        },
    },
    attention: {
        list: () => delay(MOCK_ATTENTION),
    },
    todos: {
        list: (_listIds = [], includeCompleted = false) => delay(mockTodosResult(includeCompleted)),
        add: (body) => delay(mockAddTodo(body.title)),
        complete: (reminderId) => delay(mockCompleteTodo(reminderId)),
        requestAccess: () => delay({ granted: true }),
    },
};
