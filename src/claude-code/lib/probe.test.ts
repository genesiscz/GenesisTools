import { describe, expect, test } from "bun:test";
import { probeCooccurrence } from "./probe";

describe("probeCooccurrence", () => {
    test("matches when all secondaries appear in ONE primary window", () => {
        const source = `${"x".repeat(100)}skipSlashCommands:!0,foo:1}),Jn("cron_fire")${"y".repeat(100)}`;
        const r = probeCooccurrence({ source, primary: /"cron_fire"/, secondary: [/skipSlashCommands/] });
        expect(r.matched).toBe(true);
        expect(r.windows.length).toBe(1);
    });

    test("does not match when the secondary is outside the window", () => {
        const source = `skipSlashCommands${"x".repeat(2000)}"cron_fire"`;
        const r = probeCooccurrence({
            source,
            primary: /"cron_fire"/,
            secondary: [/skipSlashCommands/],
            before: 800,
            after: 200,
        });
        expect(r.matched).toBe(false);
    });

    test("requires ALL secondaries in the SAME window", () => {
        const source = `alpha "cron_fire" ${"x".repeat(3000)} beta "cron_fire"`;
        const r = probeCooccurrence({ source, primary: /"cron_fire"/, secondary: [/alpha/, /beta/] });
        expect(r.matched).toBe(false);
    });
});
