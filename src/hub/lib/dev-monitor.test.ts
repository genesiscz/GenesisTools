import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
