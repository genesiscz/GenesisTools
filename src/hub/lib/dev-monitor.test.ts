import { describe, expect, test } from "bun:test";
import {
    classifyPerfLine,
    classifyRelayLine,
    type DevEvent,
    describeCrash,
    EventBatcher,
    formatEvent,
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
