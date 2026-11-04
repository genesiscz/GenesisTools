import { describe, expect, it } from "bun:test";
import { snapToSession } from "./index";

describe("snap it to the agent", () => {
    it("stages an uploaded photo and adds it to the session's draft", async () => {
        const calls: string[] = [];
        const receipt = await snapToSession(
            { path: "/uploads/2026-11-04/abc.jpg", provider: "claude", sessionId: "s-1" },
            {
                uploadRoot: "/uploads",
                stage: async ({ input }) => {
                    calls.push(`stage ${input}`);
                    return { id: "shelf-1" };
                },
                attach: async ({ id, key }) => {
                    calls.push(`attach ${id} ${key}`);
                    return { added: true };
                },
            }
        );

        expect(receipt).toEqual({ attached: true, draftKey: "local:claude:s-1:", shelfId: "shelf-1", error: null });
        expect(calls).toEqual(["stage /uploads/2026-11-04/abc.jpg", "attach shelf-1 local:claude:s-1:"]);
    });

    it("refuses a file outside the upload folder and an unknown provider, touching nothing", async () => {
        const deps = {
            uploadRoot: "/uploads",
            stage: async () => {
                throw new Error("must not stage");
            },
        };

        expect((await snapToSession({ path: "/etc/hosts", provider: "claude", sessionId: "s" }, deps)).error).toContain(
            "upload"
        );
        expect(
            (await snapToSession({ path: "/uploads/../etc/hosts", provider: "claude", sessionId: "s" }, deps)).attached
        ).toBe(false);
        expect(
            (await snapToSession({ path: "/uploads/a.jpg", provider: "bash", sessionId: "s" }, deps)).error
        ).toContain("provider");
    });
});
