import type { ObsidianNoteRes, ObsidianTreeRes } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { mockDashboardClient } from "@/api/mock-client";
import { noteQuery, obsidianKeys, treeQuery } from "@/features/obsidian/queries";

/**
 * Proves data flows through the D32 data layer WITHOUT a React renderer (none is installed; adding
 * one would be a D20 lib decision — see plan-05 notes). We exercise the mock client directly and the
 * `queryOptions` factories' `queryFn` against that mock — which is exactly what `useQuery` calls. The
 * thin hooks (`useVaultTree` = `useQuery(treeQuery(client))`) add no logic; the mutation hooks wrap
 * `useMutation` over the same client methods (also exercised here against the mock), so this is the
 * meaningful seam to test. Mirrors `features/pulse/queries.test.ts`.
 */

describe("mock obsidian client", () => {
    it("tree returns a vault with at least one directory", async () => {
        const { entries } = await mockDashboardClient.obsidian.tree();
        expect(entries.length).toBeGreaterThan(0);
        expect(entries.some((e) => e.isDirectory)).toBe(true);
    });

    it("note returns source + html + a publishedSlug field", async () => {
        const note = await mockDashboardClient.obsidian.note("Daily.md");
        expect(typeof note.source).toBe("string");
        expect(note.html).toContain("<");
        expect(note).toHaveProperty("publishedSlug");
    });

    it("publish returns a PublishedNote for the given vault path", async () => {
        const { note } = await mockDashboardClient.obsidian.publish("Daily.md");
        expect(note.vaultPath).toBe("Daily.md");
        expect(typeof note.slug).toBe("string");
        expect(typeof note.publishedAt).toBe("string");
    });

    it("unpublish returns the remaining published notes", async () => {
        const { remaining } = await mockDashboardClient.obsidian.unpublish("mock-note");
        expect(Array.isArray(remaining)).toBe(true);
    });

    it("mkdir echoes the created relative dir", async () => {
        const res = await mockDashboardClient.obsidian.mkdir("Projects/New");
        expect(res.ok).toBe(true);
        expect(res.relativeDir).toBe("Projects/New");
    });
});

describe("obsidian query factories", () => {
    // The factory's job is to wire key + queryFn over the injected client. We assert the wiring
    // directly and prove the data-flow via the client method the queryFn calls — no React renderer,
    // no awkward QueryFunctionContext construction (mirrors the pulse factory tests).

    it("treeQuery builds the tree key + a queryFn that calls the client", async () => {
        const opts = treeQuery(mockDashboardClient);
        expect([...opts.queryKey]).toEqual([...obsidianKeys.tree]);
        expect(typeof opts.queryFn).toBe("function");
        const data = await (opts.queryFn as unknown as () => Promise<ObsidianTreeRes>)();
        expect(data.entries.length).toBeGreaterThan(0);
    });

    it("noteQuery encodes the path into the key and stays enabled for a real path", () => {
        const opts = noteQuery(mockDashboardClient, "Projects/DevDashboard.md");
        expect([...opts.queryKey]).toEqual(["obsidian", "note", "Projects/DevDashboard.md"]);
        expect(opts.enabled).toBe(true);
    });

    it("noteQuery is disabled (and keys on '') when no note is selected", () => {
        const opts = noteQuery(mockDashboardClient, null);
        expect([...opts.queryKey]).toEqual(["obsidian", "note", ""]);
        expect(opts.enabled).toBe(false);
    });

    it("noteQuery's queryFn routes to the client for the given path", async () => {
        const opts = noteQuery(mockDashboardClient, "Daily.md");
        const data = await (opts.queryFn as unknown as () => Promise<ObsidianNoteRes>)();
        expect(data.html).toContain("Daily.md");
    });
});
