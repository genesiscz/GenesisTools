import { describe, expect, it } from "bun:test";
import { widgetSessionKey } from "../widget/types";
import { snapToSession } from "./index";

describe("snap it to the agent", () => {
    it("stages an uploaded photo and adds it to the session's draft", async () => {
        const calls: string[] = [];
        const receipt = await snapToSession(
            { path: "/uploads/2026-11-04/abc.jpg", provider: "claude", sessionId: "s-1" },
            {
                uploadRoot: "/uploads",
                sourceHome: async () => null,
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

    it("uses the indexed source home so an older phone attaches to the widget's draft", async () => {
        const target = {
            hostId: "local",
            provider: "claude",
            sessionId: "s-1",
            sourceHome: "/native/work",
            cwd: "/repo",
        } as const;
        const expectedKey = widgetSessionKey(target);
        const receipt = await snapToSession(
            { path: "/uploads/a.jpg", provider: target.provider, sessionId: target.sessionId },
            {
                uploadRoot: "/uploads",
                sourceHome: async (query) => {
                    expect(query).toEqual({ provider: target.provider, sessionId: target.sessionId });
                    return target.sourceHome;
                },
                stage: async () => ({ id: "shelf-2" }),
                attach: async ({ key }) => {
                    expect(key).toBe(expectedKey);
                    return { added: true };
                },
            }
        );
        expect(receipt).toEqual({ attached: true, draftKey: expectedKey, shelfId: "shelf-2", error: null });
    });

    it("preserves an explicit source home without consulting the index", async () => {
        const receipt = await snapToSession(
            { path: "/uploads/a.jpg", provider: "claude", sessionId: "s-1", sourceHome: "/native/personal" },
            {
                uploadRoot: "/uploads",
                sourceHome: async () => {
                    throw new Error("must not look up an explicit home");
                },
                stage: async () => ({ id: "shelf-3" }),
                attach: async () => ({ added: true }),
            }
        );
        expect(receipt.draftKey).toBe(
            widgetSessionKey({
                hostId: "local",
                provider: "claude",
                sessionId: "s-1",
                sourceHome: "/native/personal",
                cwd: "",
            })
        );
    });

    it("keeps the empty-home fallback when the index cannot be read", async () => {
        const receipt = await snapToSession(
            { path: "/uploads/a.jpg", provider: "claude", sessionId: "s-1" },
            {
                uploadRoot: "/uploads",
                sourceHome: async () => {
                    throw new Error("index unavailable");
                },
                stage: async () => ({ id: "shelf-4" }),
                attach: async () => ({ added: true }),
            }
        );
        expect(receipt.attached).toBe(true);
        expect(receipt.draftKey).toBe("local:claude:s-1:");
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
