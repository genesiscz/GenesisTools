import { describe, expect, test } from "bun:test";
import { formatReadyEvent } from "../lib/login-io";
import type { AgentRecord } from "../lib/types";

describe("formatReadyEvent", () => {
    test("emits a stdout-only ready envelope for the attached agent", () => {
        const record: AgentRecord = {
            agent_id: "main_demo",
            agent_name: "lead",
            is_main: true,
            role: null,
            registered_at: "t",
            logged_in_at: "t",
            logged_out_at: null,
            mode: "stream",
            meta: {},
        };

        expect(formatReadyEvent(record, "demo-session", "stream")).toEqual({
            type: "ready",
            agent_id: "main_demo",
            agent_name: "lead",
            session: "demo-session",
            mode: "stream",
            is_main: true,
        });
    });
});
