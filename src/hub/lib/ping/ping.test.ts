import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPing, checkPings, listPings, type PingDeps, pingDocument } from "./index";

type Row = Awaited<ReturnType<PingDeps["fleet"]>>[number];

function deps(rows: Row[]) {
    const pushes: Array<{ title: string; message: string }> = [];
    let scheduled = 0;
    const value: PingDeps = {
        document: pingDocument(join(mkdtempSync(join(tmpdir(), "ping-")), "watches.json")),
        fleet: async () => rows,
        push: async ({ title, message }) => {
            pushes.push({ title, message });
            return true;
        },
        schedule: async () => {
            scheduled += 1;
        },
        now: () => new Date("2026-11-04T15:00:00.000Z"),
    };
    return { value, pushes, scheduled: () => scheduled };
}

function row(sessionId: string, label: Row["label"], lastText: string | null = null): Row {
    return { provider: "claude", sessionId, process: null, surface: null, label, lastText };
}

describe("ping me when done", () => {
    it("pushes once when a watched turn ends, keeps a running or stalled one, and reports a gone session", async () => {
        const fleet = [row("s-run", "tool"), row("s-stall", "stalled"), row("s-done", "idle", "a\nb\nc\nd")];
        const { value, pushes, scheduled } = deps(fleet);

        for (const key of ["claude:s-run", "claude:s-stall", "claude:s-done", "claude:s-gone"]) {
            await addPing({ key, label: key === "claude:s-done" ? "shop build" : null }, value);
        }

        await addPing({ key: "claude:s-run" }, value);
        expect(listPings(value).watches).toHaveLength(4);
        expect(scheduled()).toBe(5);

        const outcomes = await checkPings(value);
        expect(outcomes.map((outcome) => [outcome.key, outcome.state])).toEqual([
            ["claude:s-run", "running"],
            ["claude:s-stall", "running"],
            ["claude:s-done", "done"],
            ["claude:s-gone", "gone"],
        ]);
        expect(pushes).toEqual([
            { title: "Done: shop build", message: "b\nc\nd" },
            { title: "Ended: claude:s-gone", message: "The session is no longer running." },
        ]);
        expect(listPings(value).watches.map((watch) => watch.key)).toEqual(["claude:s-run", "claude:s-stall"]);
        expect(await checkPings(value)).toHaveLength(2);
        expect(pushes).toHaveLength(2);
    });
});
