import { describe, expect, it } from "bun:test";
import { resolveSessionState } from "@app/utils/log-viewer/session-state";

describe("resolveSessionState", () => {
    it("returns unknown for missing task session meta", async () => {
        const result = await resolveSessionState("task", `nonexistent-${Date.now()}`);
        expect(result.state).toBe("unknown");
        expect(result.stateLabel).toBe("unknown");
    });
});
