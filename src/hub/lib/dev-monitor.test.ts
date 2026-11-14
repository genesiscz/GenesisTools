import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFailure, failureLogPath, type ToolFailure } from "@genesiscz/utils/cli/failures/record";
import { formatLocalDate } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    classifyFailureLine,
    classifyPerfLine,
    classifyProfileLine,
    classifyProfileLines,
    classifyRelayLine,
    collapse,
    DEFAULT_CLASSIFY,
    type DevEvent,
    describeCrash,
    EventBatcher,
    formatEvent,
    isHangCaptureName,
    isStoredHangCaptureName,
    readMonitorState,
    runDevMonitor,
    shortCommand,
    TextTail,
    writeMonitorState,
} from "./dev-monitor";
import { monitorPreamble, summarizeWindow } from "./dev-monitor-summary";

describe("EventBatcher", () => {
    test("the first event goes out at once, later ones wait for the delay and go out together", () => {
        const batches: DevEvent[][] = [];
        const batcher = new EventBatcher(10_000, (events) => batches.push(events));
        const event = (text: string): DevEvent => ({ kind: "stall", time: "", text });

        batcher.add(event("a"));
        expect(batcher.flush(1_000)).toBe(1);
        batcher.add(event("b"));
        batcher.add(event("c"));
        expect(batcher.flush(5_000)).toBe(0);
        expect(batcher.flush(11_000)).toBe(2);
        expect(batcher.flush(30_000)).toBe(0);
        expect(batches.map((batch) => batch.map((item) => item.text))).toEqual([["a"], ["b", "c"]]);
    });
});

describe("classifyPerfLine", () => {
    test("a wedge, a hang sample and its stacks are events, with the file to read", () => {
        expect(
            classifyPerfLine(
                "[01:47:04.478] mark main-stall ongoing 25.0s load=9.0 area=prs recent=[main-thread WEDGED for 20s]"
            )
        ).toMatchObject({ kind: "wedge", time: "01:47:04.478", text: "main-stall ongoing 25.0s load=9.0 area=prs" });
        expect(
            classifyPerfLine(
                "[01:46:40.479] mark main-stall 1.0s so far — sampling to hang-2026-10-08-014640.txt area=prs"
            )?.file
        ).toEndWith("logs/hangs/hang-2026-10-08-014640.txt");
        expect(
            classifyPerfLine("[01:50:13.776] mark main-stall stacks (30 samples, 764 ms) → stack-2026-10-08-015013.txt")
                ?.kind
        ).toBe("hang");
    });

    test("a burst of child processes is an event; only ongoing lines share a source-specific key", () => {
        expect(
            classifyPerfLine(
                "[19:26:02.100] mark spawn.storm 51 child processes started in 10 s, 49 running; GenesisTools agents blame ×51"
            )
        ).toMatchObject({ kind: "storm", time: "19:26:02.100", key: undefined });
        const ongoing = "[19:26:32.100] mark spawn.storm ongoing 30 s: 400 child processes started";
        expect(classifyPerfLine(ongoing, DEFAULT_CLASSIFY, "/tools/hangs")?.key).toBe("/tools/hangs:storm:ongoing");
        expect(classifyPerfLine(ongoing, DEFAULT_CLASSIFY, "/genesis/hangs")?.key).toBe("/genesis/hangs:storm:ongoing");
        expect(classifyPerfLine("[19:26:33.100] mark spawn.storm over after 30 s")?.key).toBeUndefined();
    });

    test("a Genesis Markdown line carries its tag, and its hang sample lives in its own folder", () => {
        const event = classifyPerfLine(
            "[17:12:43.850] [md] mark main-stall 1.0s so far — sampling to hang-2026-10-23-171243.txt recent=[x]",
            DEFAULT_CLASSIFY,
            "/home/fixture/.genesis/logs/hangs"
        );
        expect(event).toMatchObject({
            kind: "hang",
            file: "/home/fixture/.genesis/logs/hangs/hang-2026-10-23-171243.txt",
            text: "[md] main-stall 1.0s so far — sampling to hang-2026-10-23-171243.txt",
        });
        expect(classifyPerfLine("[17:11:59.681] [md] mark main-stall recovered after 1806ms load=159")?.kind).toBe(
            "stall"
        );
    });

    test("tagged helper events remain distinct from otherwise identical parent events", () => {
        for (const body of [
            "spawn.storm ongoing 30 s: 100 child processes started",
            "main-spin 5s at 99% cpu: the main thread never idles",
            "main-stall recovered after 1806ms",
        ]) {
            const parent = classifyPerfLine(`[10:00:00] mark ${body}`, DEFAULT_CLASSIFY, "/genesis/hangs");
            const helper = classifyPerfLine(`[10:00:00] [md] mark ${body}`, DEFAULT_CLASSIFY, "/genesis/hangs");
            expect(parent?.text).toBe(body);
            expect(helper?.text).toBe(`[md] ${body}`);
            expect(helper?.kind).toBe(parent?.kind);

            if (parent && helper) {
                expect(collapse([parent, helper])).toHaveLength(2);
            }
        }
    });

    test("a main thread spinning at full CPU is an event, and its sample names the file", () => {
        expect(classifyPerfLine("[17:10:32.100] mark main-spin 5s at 99% cpu: the main thread never idles")?.kind).toBe(
            "spin"
        );
        expect(classifyPerfLine("[17:10:34.200] mark main-spin bodies in 2s: bodies[widget.inbox.row=812]")?.kind).toBe(
            "spin"
        );
        expect(
            classifyPerfLine("[17:10:32.101] mark main-spin 5.0s so far — sampling to hang-2026-10-23-171032.txt")?.file
        ).toEndWith("logs/hangs/hang-2026-10-23-171032.txt");
    });

    test("short stalls, quick main-thread spans and routine lines are left out", () => {
        expect(classifyPerfLine("[01:48:30.597] mark main-stall recovered after 319ms load=6.3")).toBeNull();
        expect(classifyPerfLine("[01:48:30.597] mark main-stall recovered after 819ms load=6.3")?.kind).toBe("stall");
        expect(classifyPerfLine("[01:50:13.759] mark hub.prs.list.render main busy 867.9 ms of 600 ms")?.kind).toBe(
            "slow-main"
        );
        expect(classifyPerfLine("[01:50:13.759] mark hub.prs.readiness.render main busy 33.9 ms of 600 ms")).toBeNull();
        expect(classifyPerfLine("[02:01:53.228] hub.review.load 197.6ms")).toBeNull();
        expect(classifyPerfLine("[02:01:53.228] mark hub.review.load SLOW 197.6ms off-main: uncommitted")).toBeNull();
        expect(
            classifyPerfLine(
                "[01:48:50.058] mark hub.prs.readiness SLOW 4419.9ms off-main: 12 prs 12 answered, 0 cached, 0 failed"
            )
        ).toBeNull();
    });

    test("a layout loop, heavy frame drops and failures are events", () => {
        expect(
            classifyPerfLine("[02:00:00.000] mark hub.layout.loop prs.detail: 31 width writes in 1 s, last 812,813")
                ?.kind
        ).toBe("layout-loop");
        expect(
            classifyPerfLine("[01:46:34.305] mark frames 7 dropped of 284 in 5.1s, worst 597ms, lost 2095ms area=prs")
                ?.kind
        ).toBe("jank");
        expect(
            classifyPerfLine("[01:46:34.305] mark frames 1 dropped of 471 in 5.0s, worst 62ms, lost 52ms")
        ).toBeNull();
        expect(classifyPerfLine("[22:21:38.373] mark hub.link forward failed: some error")?.kind).toBe("error");
    });
});

describe("classifyProfileLine", () => {
    test("a timer or a command run of a second or more is an event; summaries, marks and quick ones are not", () => {
        expect(classifyProfileLine("[profile:agent-sessions] discover.walk 1.234s trace=ab12")).toMatchObject({
            kind: "slow",
            text: "agent-sessions discover.walk 1.23s trace=ab12",
            ms: 1234,
        });
        expect(
            classifyProfileLine("[profile:cli] agents changes exit=0 cpu=1353ms rss=2470MB caller=app 1.117s")?.text
        ).toBe("cli agents changes exit=0 cpu=1353ms rss=2470MB caller=app 1.12s");
        expect(
            classifyProfileLine("[profile:cli] hub serve exit=0 cpu=692ms rss=104MB caller=shell 60.06s")
        ).toBeNull();
        expect(classifyProfileLine("[profile:cli] hub prs exit=0 cpu=200ms rss=104MB caller=app 3.5s")?.kind).toBe(
            "slow"
        );
        expect(classifyProfileLine("[profile:widget] sessions 53.89ms")).toBeNull();
        expect(
            classifyProfileLine(
                "[profile:agent-sessions] discover.walk roots=~/.claude/projects files=30631 1.07s pid=999999999"
            )?.text
        ).toBe("agent-sessions discover.walk roots=~/.claude/projects files=30631 1.07s [pid 999999999]");
        expect(classifyProfileLine("[profile:a] walk 1.5s trace=t1 pid=999999999")?.text).toBe(
            "a walk 1.50s trace=t1 [pid 999999999]"
        );
        expect(shortCommand("/x/gt-hub --preload /a.ts --preload /b.ts /r/src/hub/index.ts serve --port 1")).toBe(
            "hub serve"
        );
        expect(shortCommand("/x/bun /r/tools agents changes abc --tools t1 --json")).toBe("agents changes abc");
        expect(classifyProfileLine("[profile:agent-sessions] @sync.discover-full-skipped 4.5s")).toBeNull();
        expect(
            classifyProfileLine(
                "[profile:cmux]   list-workspaces          n=    1  total=  3000ms  avg=  3000ms  max=  3000ms"
            )
        ).toBeNull();
        expect(
            classifyProfileLine("[profile:widget] sessions 653ms", { ...DEFAULT_CLASSIFY, minProfileMs: 500 })?.kind
        ).toBe("slow");
    });

    test("a batch shows one line per slow timer with its count and maximum", () => {
        const events = [
            classifyProfileLine("[profile:a] walk 1.0s"),
            { kind: "stall" as const, time: "", text: "x" },
            classifyProfileLine("[profile:a] walk 3.0s"),
            classifyProfileLine("[profile:a] walk 2.0s"),
        ].filter((event): event is DevEvent => event !== null);
        expect(collapse(events).map((event) => event.text)).toEqual(["a walk 1.00s (×3, max 3.00s)", "x"]);
    });
});

describe("classifyRelayLine", () => {
    test("only the lines that say the relay is not doing its job", () => {
        expect(
            classifyRelayLine(
                "2026-10-08T00:07:30.375+02:00 pid=99244 relay previous relay pid=88334 ended without a clean exit"
            )
        ).toMatchObject({ kind: "relay", time: "00:07:30" });
        expect(classifyRelayLine("2026-10-08T00:07:58.890+02:00 pid=5518 relay focus back to cmux")).toBeNull();
    });
});

describe("describeCrash", () => {
    test("names the app and the exception of an .ips report", () => {
        const ips = `{"app_name":"GenesisTools Preview","bug_type":"309"}\n{"exception" : {"codes":"0x1","type":"EXC_BAD_ACCESS","signal":"SIGSEGV"}}`;
        const event = describeCrash("/reports/GenesisTools Preview-2026-10-08-021500.ips", ips);
        expect(event.text).toBe("GenesisTools Preview crashed: EXC_BAD_ACCESS SIGSEGV");
        expect(formatEvent({ ...event, time: "02:15:00" })).toBe(
            "[02:15:00] crash GenesisTools Preview crashed: EXC_BAD_ACCESS SIGSEGV (/reports/GenesisTools Preview-2026-10-08-021500.ips)"
        );
    });
});

test("aborting interrupts a long monitor interval", async () => {
    const controller = new AbortController();
    const run = runDevMonitor({
        ...DEFAULT_CLASSIFY,
        fromStart: false,
        intervalMs: 60_000,
        minDelayMs: 10_000,
        signal: controller.signal,
        emit: () => {},
    });
    controller.abort();
    await run;
}, 1000);

test("profile classification never launches a per-PID subprocess", () => {
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => {
        throw new Error("pure classification must not spawn ps");
    });

    try {
        expect(classifyProfileLine("[profile:a] walk 1.5s pid=1001")?.text).toBe("a walk 1.50s [pid 1001]");
        expect(spawn).not.toHaveBeenCalled();
    } finally {
        spawn.mockRestore();
    }
});

test("a burst of profile PIDs uses one process snapshot and retains names and missing PIDs", async () => {
    let snapshots = 0;
    const lines = Array.from({ length: 100 }, (_, index) => `[profile:a] walk 1.5s pid=${1000 + index}`);
    const events = await classifyProfileLines({
        lines,
        readProcesses: async () => {
            snapshots += 1;
            return [{ pid: 1000, cpu: 0, rssKb: 0, command: "/r/gt-hub /r/src/hub/index.ts serve" }];
        },
    });
    expect(snapshots).toBe(1);
    expect(events).toHaveLength(100);
    expect(events[0].text).toBe("a walk 1.50s [pid 1000 hub serve]");
    expect(events[99].text).toBe("a walk 1.50s [pid 1099]");
    await classifyProfileLines({
        lines: ["[profile:a] fast 1ms pid=1000", "[profile:a] walk 1.5s"],
        readProcesses: async () => {
            throw new Error("no qualifying PID: do not query ps");
        },
    });
});

test("process snapshots have a deadline and an empty answer retains the slow event by PID", async () => {
    const events = await classifyProfileLines({
        lines: ["[profile:a] walk 1.5s pid=1000"],
        readProcesses: async (options) => {
            expect(options?.timeoutMs).toBe(1000);
            return [];
        },
    });
    expect(events.map((event) => event.text)).toEqual(["a walk 1.50s [pid 1000]"]);
});

test("log tails read bounded chunks without losing lines or UTF-8 at chunk boundaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "monitor-tail-"));
    const file = join(dir, "app.log");
    const first = `${"a".repeat(65_535)}é\n`;
    const lines = Array.from({ length: 12_000 }, (_, index) => `line ${index} ${"x".repeat(90)}`);
    writeFileSync(file, `${first}${lines.join("\n")}\n`);
    try {
        const tail = new TextTail(file, true);
        const read = tail.read();
        // One pass drains several 64 KB chunks (about 650 lines each) but stops at its byte budget.
        expect(read.length).toBeGreaterThan(5000);
        expect(read.length).toBeLessThan(lines.length);
        const all = [...read];
        for (let index = 0; index < 10; index++) {
            all.push(...tail.read());
        }
        expect(all).toEqual([first.trimEnd(), ...lines]);
        expect(tail.read()).toEqual([]);
        writeFileSync(file, "rotated\n");
        expect(tail.read()).toEqual(["rotated"]);
        const afterStart = new TextTail(file, false);
        expect(afterStart.read()).toEqual([]);
        writeFileSync(file, "rotated\nnext\n");
        expect(afterStart.read()).toEqual(["next"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("both perf tails retain their storm updates and endings in a batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monitor-storm-"));
    const sources = monitorFixtureSources(dir);
    const batches: DevEvent[][] = [];
    const controller = new AbortController();
    writeFileSync(
        sources.perfLog,
        [
            "[10:00:00] mark spawn.storm ongoing 30 s: 100 child processes started",
            "[10:00:01] mark spawn.storm ongoing 60 s: 200 child processes started",
            "[10:00:02] mark spawn.storm over after 60 s",
            "[10:00:03] mark spawn.storm over after 1 s",
            "",
        ].join("\n")
    );
    writeFileSync(
        sources.genesisPerfLog,
        [
            "[10:00:00] mark spawn.storm ongoing 30 s: 250 child processes started",
            "[10:00:00] [md] mark spawn.storm ongoing 30 s: 300 child processes started",
            "[10:00:02] [md] mark spawn.storm over after 30 s",
            "",
        ].join("\n")
    );

    try {
        await runDevMonitor({
            ...DEFAULT_CLASSIFY,
            sources,
            fromStart: true,
            intervalMs: 100,
            minDelayMs: 0,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
            emit: (events) => {
                batches.push(events);
                controller.abort();
            },
        });
        expect(batches).toHaveLength(1);
        expect(batches[0].map((event) => event.text)).toEqual([
            "spawn.storm ongoing 60 s: 200 child processes started (×2)",
            "spawn.storm over after 60 s",
            "spawn.storm over after 1 s",
            "Genesis: spawn.storm ongoing 30 s: 250 child processes started",
            "Genesis: [md] spawn.storm ongoing 30 s: 300 child processes started",
            "Genesis: [md] spawn.storm over after 30 s",
        ]);
        expect(batches[0][0].time).toBe("10:00:01");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a logged hang in one app cannot suppress the other app's same-named unannounced hang", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monitor-hangs-"));
    const sources = monitorFixtureSources(dir);
    const name = "hang-2026-01-01-100000.txt";
    const batches: DevEvent[][] = [];
    const controller = new AbortController();
    writeFileSync(sources.perfLog, `[10:00:00] mark main-stall 1s so far sampling to ${name}\n`);

    try {
        await runDevMonitor({
            ...DEFAULT_CLASSIFY,
            sources,
            fromStart: true,
            intervalMs: 100,
            minDelayMs: 0,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
            emit: (events) => {
                batches.push(events);
                if (batches.length === 1) {
                    writeFileSync(join(sources.hangs, name), "logged sample");
                    writeFileSync(join(sources.genesisHangs, name), "unannounced sample");
                } else {
                    controller.abort();
                }
            },
        });
        expect(batches).toHaveLength(2);
        expect(batches[0]).toHaveLength(1);
        expect(batches[0][0].file).toBe(join(sources.hangs, name));
        expect(batches[1]).toHaveLength(1);
        expect(batches[1][0]).toMatchObject({
            kind: "hang",
            file: join(sources.genesisHangs, name),
            text: "a hang sample was written with no app-perf.log line",
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** `hang-<local yyyy-MM-dd-HHmmss>.txt`, the name HangWatch.swift gives a capture taken at `at`. */
function hangCaptureName(at: Date, extension = ".txt"): string {
    return `hang-${formatLocalDate(at)}-${at.toTimeString().slice(0, 8).replaceAll(":", "")}${extension}`;
}

function monitorFixtureSources(dir: string) {
    const sources = {
        perfLog: join(dir, "app-perf.log"),
        genesisPerfLog: join(dir, "perf.log"),
        genesisHangs: join(dir, "genesis-hangs"),
        profileLog: () => join(dir, "profiling.log"),
        relayLog: join(dir, "relay.log"),
        hangs: join(dir, "hangs"),
        crashes: join(dir, "crashes"),
        failuresLog: () => failureLogPath(formatLocalDate(new Date()), join(dir, "logs")),
        failuresDir: join(dir, "logs"),
        state: join(dir, "hub", "dev-monitor-state.json"),
    };
    for (const folder of [sources.hangs, sources.genesisHangs, sources.crashes]) {
        mkdirSync(folder);
    }
    return sources;
}

function failureRecord(overrides: Partial<ToolFailure>): ToolFailure {
    return {
        v: 1,
        id: "lx1-42-d1",
        at: new Date().toISOString(),
        kind: "deadline",
        tool: "git",
        command: "git commits",
        argv: ["commits"],
        exitCode: null,
        message: "Command timed out after 60000ms (the default deadline of an Executor call): git fetch origin.",
        errorName: "Error",
        stack: null,
        stderrTail: null,
        fatal: false,
        durationMs: 60_010,
        pid: 42,
        ppid: 1,
        cwd: "/repo",
        traceId: null,
        toolsRoot: "/repo",
        caller: null,
        child: { command: ["git", "fetch", "origin"], cwd: "/repo", timeoutMs: 60_000, defaulted: true, reason: null },
        ...overrides,
    };
}

describe("command deadlines", () => {
    test("a deadline record is one event naming the child, the bound and the command that shows it", () => {
        const event = classifyFailureLine(SafeJSON.stringify(failureRecord({})));

        expect(event).toMatchObject({
            kind: "deadline",
            key: "deadline:git fetch origin",
            text: "git fetch origin killed after 60000ms (default), run by tools git commits: tools genesis-tools logs show lx1-42-d1",
        });
        const forge = failureRecord({
            child: {
                command: ["gh", "api", "x"],
                cwd: "/r",
                timeoutMs: 600_000,
                defaulted: false,
                reason: "a paged call",
            },
        });
        expect(classifyFailureLine(SafeJSON.stringify(forge))?.text).toStartWith(
            "gh api x killed after 600000ms (a paged call)"
        );
    });

    test("no other failure kind is an event, nor a line that is not a record", () => {
        expect(classifyFailureLine(SafeJSON.stringify(failureRecord({ kind: "usage", child: undefined })))).toBeNull();
        expect(classifyFailureLine(SafeJSON.stringify(failureRecord({ kind: "error" })))).toBeNull();
        expect(classifyFailureLine("{not json")).toBeNull();
    });

    test("two deadlines of one command collapse into one line with a count", () => {
        const one = classifyFailureLine(SafeJSON.stringify(failureRecord({ id: "a" })));
        const two = classifyFailureLine(SafeJSON.stringify(failureRecord({ id: "b" })));
        const collapsed = collapse([one, two].filter((event): event is DevEvent => event !== null));

        expect(collapsed).toHaveLength(1);
        expect(collapsed[0].text).toEndWith("logs show a (×2)");
    });

    test("the running monitor emits a deadline from the failures log of today, and saves its state when it stops", async () => {
        const dir = mkdtempSync(join(tmpdir(), "monitor-deadline-"));
        const sources = monitorFixtureSources(dir);
        const batches: DevEvent[][] = [];
        const controller = new AbortController();
        const before = Date.now();
        appendFailure(failureRecord({ kind: "usage", child: undefined }), sources.failuresDir);
        appendFailure(failureRecord({}), sources.failuresDir);

        try {
            await runDevMonitor({
                ...DEFAULT_CLASSIFY,
                sources,
                fromStart: true,
                intervalMs: 100,
                minDelayMs: 0,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
                emit: (events) => {
                    batches.push(events);
                    controller.abort();
                },
            });
            expect(batches).toHaveLength(1);
            expect(batches[0].map((event) => event.kind)).toEqual(["deadline"]);
            expect(Date.parse(readMonitorState(sources.state)?.lastRunAt ?? "")).toBeGreaterThanOrEqual(before - 1000);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a deadline written while the monitor waits out its interval is emitted before it stops", async () => {
        const dir = mkdtempSync(join(tmpdir(), "monitor-drain-"));
        const sources = monitorFixtureSources(dir);
        const batches: DevEvent[][] = [];
        const controller = new AbortController();

        try {
            const run = runDevMonitor({
                ...DEFAULT_CLASSIFY,
                sources,
                fromStart: false,
                intervalMs: 60_000,
                minDelayMs: 0,
                signal: controller.signal,
                emit: (events) => batches.push(events),
            });
            // The first read ends with the first save; from then on the monitor waits out its long interval.
            const giveUpAt = Date.now() + 5000;

            while (readMonitorState(sources.state) === null && Date.now() < giveUpAt) {
                await Bun.sleep(100);
            }

            const firstSave = readMonitorState(sources.state)?.lastRunAt ?? "";
            const writtenAt = Date.now();
            appendFailure(failureRecord({}), sources.failuresDir);
            controller.abort();
            await run;

            // The watermark of the first save is the start of its read, never later than the write it did not see.
            expect(Date.parse(firstSave)).toBeLessThanOrEqual(writtenAt);
            expect(batches.flat().map((event) => event.kind)).toEqual(["deadline"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("the summary of what happened while no monitor ran", () => {
    test("counts a fixture window and names the command that lists each count", () => {
        const dir = mkdtempSync(join(tmpdir(), "monitor-summary-"));
        const sources = monitorFixtureSources(dir);
        const until = new Date();
        const since = new Date(until.getTime() - 3_600_000);
        const inside = new Date(until.getTime() - 60_000).toISOString();
        const outside = new Date(until.getTime() - 7_200_000).toISOString();

        try {
            appendFailure(failureRecord({ at: inside }), sources.failuresDir);
            appendFailure(failureRecord({ at: outside }), sources.failuresDir);
            appendFailure(failureRecord({ at: inside, kind: "error", child: undefined }), sources.failuresDir);
            appendFailure(failureRecord({ at: inside, kind: "usage", child: undefined }), sources.failuresDir);
            const day = formatLocalDate(until);
            // A hang capture counts at the stamp in its name, a crash report at its mtime.
            writeFileSync(join(sources.hangs, hangCaptureName(new Date(inside))), "sample");
            writeFileSync(join(sources.crashes, `GenesisTools-${day}-100000.ips`), "{}");
            writeFileSync(join(sources.crashes, `Other-${day}-100000.ips`), "{}");
            writeFileSync(join(sources.genesisHangs, hangCaptureName(new Date(outside))), "an older sample");
            const written = new Date(inside);
            for (const file of [`GenesisTools-${day}-100000.ips`, `Other-${day}-100000.ips`]) {
                utimesSync(join(sources.crashes, file), written, written);
            }

            const summary = summarizeWindow({ since, until, sources });
            const from = `${formatLocalDate(since)}T${since.toTimeString().slice(0, 5)}`;

            expect(summary.counts).toEqual({ deadlines: 1, failedRuns: 1, hangs: 1, crashes: 1 });
            expect(summary.commands).toEqual({
                deadlines: `tools genesis-tools logs failures --kind deadline --since ${from}`,
                failedRuns: `tools genesis-tools logs failures --kind error crash exit --since ${from}`,
                hangs: sources.hangs,
                crashes: `tools genesis-tools logs crashes --since ${from}`,
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("a window of several days counts the .txt.zst the daily pass made of a capture, at the capture's own time", () => {
        const dir = mkdtempSync(join(tmpdir(), "monitor-summary-zst-"));
        const sources = monitorFixtureSources(dir);
        const hour = 3_600_000;
        const until = new Date();
        const since = new Date(until.getTime() - 4 * 24 * hour);

        try {
            // Compressed today, captured three and two days ago: the mtime is the compression's, the name the capture's.
            writeFileSync(
                join(sources.hangs, hangCaptureName(new Date(until.getTime() - 3 * 24 * hour), ".txt.zst")),
                ""
            );
            writeFileSync(
                join(sources.genesisHangs, hangCaptureName(new Date(until.getTime() - 2 * 24 * hour), ".txt.zst")),
                ""
            );
            writeFileSync(join(sources.hangs, hangCaptureName(new Date(until.getTime() - hour))), "a plain one");
            // Captured before the window and compressed inside it: not a hang of the window.
            writeFileSync(join(sources.hangs, hangCaptureName(new Date(since.getTime() - 600_000), ".txt.zst")), "");
            // A main-thread stack sample is no hang capture, in either form.
            writeFileSync(join(sources.hangs, `stack-${formatLocalDate(until)}-100000.txt.zst`), "");

            const summary = summarizeWindow({ since, until, sources });

            expect(summary.counts.hangs).toBe(3);
            expect(summary.commands.hangs).toBe(`${sources.hangs}, ${sources.genesisHangs}`);
            // The live watcher still takes a new .zst for a compression, not a new hang.
            expect(isHangCaptureName("hang-2026-11-01-100000.txt.zst")).toBe(false);
            expect(isStoredHangCaptureName("hang-2026-11-01-100000.txt.zst")).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("the preamble prints the summary from the saved state, one line when nothing happened, none with --no-summary", () => {
        const dir = mkdtempSync(join(tmpdir(), "monitor-preamble-"));
        const sources = monitorFixtureSources(dir);
        const now = new Date();

        try {
            writeMonitorState(sources.state, new Date(now.getTime() - 60_000));
            const quiet = monitorPreamble({ sources, json: false, summary: true, now }).trimEnd().split("\n");
            expect(quiet).toHaveLength(2);
            expect(quiet[1]).toEndWith("while no monitor ran: no command deadlines, failed runs, hangs or crashes");

            appendFailure(failureRecord({ at: new Date(now.getTime() - 30_000).toISOString() }), sources.failuresDir);
            const json = monitorPreamble({ sources, json: true, summary: true, now }).trimEnd().split("\n");
            expect(SafeJSON.parse(json[1], { strict: true })).toMatchObject({
                kind: "summary",
                since: new Date(now.getTime() - 60_000).toISOString(),
                counts: { deadlines: 1, failedRuns: 0, hangs: 0, crashes: 0 },
            });

            expect(monitorPreamble({ sources, json: false, summary: false, now }).trimEnd().split("\n")).toHaveLength(
                1
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
