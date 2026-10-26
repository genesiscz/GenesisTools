import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
    runDevMonitor,
    shortCommand,
    TextTail,
} from "./dev-monitor";

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

function monitorFixtureSources(dir: string) {
    const sources = {
        perfLog: join(dir, "app-perf.log"),
        genesisPerfLog: join(dir, "perf.log"),
        genesisHangs: join(dir, "genesis-hangs"),
        profileLog: () => join(dir, "profiling.log"),
        relayLog: join(dir, "relay.log"),
        hangs: join(dir, "hangs"),
        crashes: join(dir, "crashes"),
    };
    for (const folder of [sources.hangs, sources.genesisHangs, sources.crashes]) {
        mkdirSync(folder);
    }
    return sources;
}
