import { describe, expect, it } from "bun:test";
import { appendToVault, clipToVault, type VaultDeps } from "./index";

function deps(runs: string[][], saved: Array<{ relativeDir: string; baseName: string; content: string }>, stdout = "") {
    return {
        vaultRoot: async () => "/vault",
        inbox: async () => ({ folder: "Inbox", prefix: "Phone inbox" }),
        save: async (opts) => {
            saved.push(opts);
            return { path: `/vault/${opts.relativeDir}/${opts.baseName}.md` };
        },
        run: async (args) => {
            runs.push(args);
            return { stdout, stderr: "", exitCode: 0 };
        },
        now: new Date(2026, 10, 4, 9, 30),
    } satisfies VaultDeps;
}

describe("send to my vault", () => {
    it("clips a page as Markdown into the inbox note of the day, with its source", async () => {
        const runs: string[][] = [];
        const saved: Array<{ relativeDir: string; baseName: string; content: string }> = [];
        const receipt = await clipToVault(
            { url: "https://blog.example/post", note: "read later" },
            deps(runs, saved, "---\ntitle: A post\n---\nBody text")
        );

        expect(runs).toEqual([["fetch", "https://blog.example/post", "--depth", "advanced", "--tokens", "6000"]]);
        expect(receipt).toEqual({
            kind: "page",
            note: "Inbox/2026-11-04 Phone inbox.md",
            title: "A post",
            error: null,
        });
        expect(saved[0].content).toContain("Source: https://blog.example/post");
        expect(saved[0].content).toContain("read later");
    });

    it("queues a video and refuses a link that is not http", async () => {
        const runs: string[][] = [];
        const saved: Array<{ relativeDir: string; baseName: string; content: string }> = [];
        const video = await clipToVault({ url: "https://youtu.be/abc123" }, deps(runs, saved));
        const bad = await clipToVault({ url: "file:///etc/hosts" }, deps(runs, saved));

        expect(runs).toEqual([["youtube", "queue", "add", "https://youtu.be/abc123"]]);
        expect(video.kind).toBe("video");
        expect(bad.error).toContain("http");
    });

    it("appends to a named note in a folder", async () => {
        const saved: Array<{ relativeDir: string; baseName: string; content: string }> = [];
        const receipt = await appendToVault(
            { text: "an answer", folder: "Projects/shop", name: "Answers" },
            deps([], saved)
        );

        expect(receipt.note).toBe("Projects/shop/Answers.md");
        expect(saved[0]).toMatchObject({ relativeDir: "Projects/shop", baseName: "Answers", content: "an answer\n" });
    });
});
