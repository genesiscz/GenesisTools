import { describe, expect, it } from "bun:test";
import { parseInterval } from "@app/daemon/lib/interval";
import { SHOPS_DAEMON_TASKS } from "./daemon";

describe("SHOPS_DAEMON_TASKS", () => {
    it("registers exactly two tasks", () => {
        expect(SHOPS_DAEMON_TASKS).toHaveLength(2);
    });

    it("every value is the long form (parser-compatible)", () => {
        for (const t of SHOPS_DAEMON_TASKS) {
            expect(() => parseInterval(t.every)).not.toThrow();
        }
    });

    it("watchlist-check has notify:false", () => {
        const wc = SHOPS_DAEMON_TASKS.find((t) => t.name === "shops:watchlist-check");
        expect(wc?.notify).toBe(false);
    });

    it("uses tools shops sub-commands", () => {
        for (const t of SHOPS_DAEMON_TASKS) {
            expect(t.command).toMatch(/^tools shops /);
        }
    });
});
