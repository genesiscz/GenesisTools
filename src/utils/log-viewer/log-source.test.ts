import { describe, expect, it } from "bun:test";
import { taskRecordToLogEntry } from "./log-source";

describe("taskRecordToLogEntry", () => {
    it("uses stored level when present", () => {
        const entry = taskRecordToLogEntry({
            type: "line",
            seq: 1,
            out: "stderr",
            level: "warn",
            ts: 1,
            text: "ignored for level",
        });

        expect(entry.level).toBe("warn");
    });

    it("re-infers level for legacy records without level", () => {
        expect(
            taskRecordToLogEntry({
                type: "line",
                seq: 1,
                out: "stderr",
                ts: 1,
                text: "▲ WARN  Fast Refresh reload batch",
            }).level
        ).toBe("warn");

        expect(
            taskRecordToLogEntry({
                type: "line",
                seq: 2,
                out: "stderr",
                ts: 1,
                text: "INFO  token=value",
            }).level
        ).toBe("info");

        expect(
            taskRecordToLogEntry({
                type: "line",
                seq: 3,
                out: "stderr",
                ts: 1,
                text: "Error: TransformError",
            }).level
        ).toBe("error");
    });
});
