import { describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import {
    appendReclaimEvent,
    newReclaimRunId,
    readReclaimEvents,
    reclaimRunPath,
} from "@app/macos/lib/clones/reclaim-run";

describe("reclaim run log", () => {
    it("appends events in order with a timestamp and reads them back", () => {
        const id = newReclaimRunId();
        try {
            appendReclaimEvent(id, { phase: "start", dirs: ["/tmp/x"] });
            appendReclaimEvent(id, { phase: "discover", roots: 2, skipped: 1 });
            appendReclaimEvent(id, { phase: "plan", sets: 3, totalReclaimable: 999 });

            const events = readReclaimEvents(id);
            expect(events.map((e) => e.phase)).toEqual(["start", "discover", "plan"]);
            expect(events[1].roots).toBe(2);
            expect(typeof events[0].ts).toBe("string");
            expect(Number.isNaN(Date.parse(events[0].ts))).toBe(false);
        } finally {
            if (existsSync(reclaimRunPath(id))) {
                rmSync(reclaimRunPath(id));
            }
        }
    });

    it("two ids in the same process do not collide", () => {
        const a = newReclaimRunId();
        const b = newReclaimRunId();
        expect(a).not.toBe(b);
    });

    it("reading an unknown run returns an empty list", () => {
        expect(readReclaimEvents("no-such-run-id")).toEqual([]);
    });
});
