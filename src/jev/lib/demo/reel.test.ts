import { expect, test } from "bun:test";
import { refuseUserMail, runDemo } from "./reel";

test("route and compact demos succeed on fixtures", async () => {
    const route = await runDemo("route");
    expect(route.ok).toBe(true);
    const compact = await runDemo("compact");
    expect(compact.ok).toBe(true);
});

test("unknown demo names are rejected", async () => {
    await expect(runDemo("fly")).rejects.toThrow(/Unknown demo/);
});

test("Mail is refused without the break-glass flag", () => {
    expect(() => refuseUserMail("Mail")).toThrow(/Mail/);
    expect(() => refuseUserMail("Mail", true)).not.toThrow();
});
