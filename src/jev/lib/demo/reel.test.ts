import { expect, test } from "bun:test";
import { demoTrace, refuseUserMail, runDemo } from "./reel";

test("route and compact demos succeed on fixtures", async () => {
    const route = await runDemo("route");
    expect(route.ok).toBe(true);
    const compact = await runDemo("compact");
    expect(compact.ok).toBe(true);
});

test("unknown demo names are rejected", async () => {
    await expect(runDemo("fly")).rejects.toThrow(/Unknown demo/);
});

test("demo traces keep the stable v2 schema", async () => {
    const trace = demoTrace(await runDemo("route"), "2026-09-18T00:00:00.000Z");
    expect(trace).toMatchObject({
        demo: "route",
        startedAt: "2026-09-18T00:00:00.000Z",
        ok: true,
        readback: false,
    });
    expect(trace.events[0]?.kind).toBe("summary");
});

test("Mail is refused without the break-glass flag", () => {
    expect(() => refuseUserMail("Mail")).toThrow(/Mail/);
    expect(() => refuseUserMail("Mail", true)).not.toThrow();
});
