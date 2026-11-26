import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDevDashboardStorage, resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { routerToResponse } from "@app/dev-dashboard/server/adapters/bun-serve";
import { defaultSystemCollector } from "@app/dev-dashboard/server/collector/SystemCollector";
import { Router } from "@app/dev-dashboard/server/router";
import { obsidianRoutes } from "@app/dev-dashboard/server/routes/obsidian";
import { env } from "@genesiscz/utils/env";
import {
    findPublication,
    publicationsPath,
    savePublication,
    updateShareConfig,
} from "@genesiscz/utils/genesis-tools/publish/store";
import { SafeJSON } from "@genesiscz/utils/json";
import { loadSharePublishConfig } from "../share/legacy-share";
import { shareStatusFor } from "../share/status";
import { unshareFromTargets } from "../share/targets";
import { vaultShareSource } from "../share/vault-source";
import { findPublishedBySlug } from "./publish";
import { resolvePublishedSlug, shareNote, toVaultRelativePath } from "./share-note";

describe("toVaultRelativePath", () => {
    const root = "/vault";

    test("keeps a vault-relative .md path", () => {
        expect(toVaultRelativePath("Widgets/Design/Note.md", root)).toBe("Widgets/Design/Note.md");
    });

    test("appends .md when omitted", () => {
        expect(toVaultRelativePath("Widgets/Design/Note", root)).toBe("Widgets/Design/Note.md");
    });

    test("keeps a source file's own extension", () => {
        expect(toVaultRelativePath("Widgets/Design/Report.ts", root)).toBe("Widgets/Design/Report.ts");
    });

    test("converts an absolute path inside the vault", () => {
        expect(toVaultRelativePath("/vault/Widgets/Design/Note.md", root)).toBe("Widgets/Design/Note.md");
    });

    test("rejects a path that leaves the vault", () => {
        expect(() => toVaultRelativePath("../outside.md", root)).toThrow(/escapes vault/);
    });

    test("rejects an empty path", () => {
        expect(() => toVaultRelativePath("  ", root)).toThrow(/path required/);
    });
});

describe("shareNote", () => {
    let dir = "";
    let vault = "";

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), "share-note-"));
        vault = join(dir, "vault");
        mkdirSync(join(vault, "Widgets", "Design"), { recursive: true });
        writeFileSync(join(vault, "Widgets", "Design", "Note.md"), "# hi\n");
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        resetDevDashboardStorage();
        await getDevDashboardStorage().setConfig({
            port: 3042,
            obsidianVault: vault,
            allowedHosts: ["mac.example.com"],
            publishedNotes: [],
            cmuxPollIntervalMs: 2000,
        });
    });

    afterEach(() => {
        env.testing.unset("GENESIS_TOOLS_HOME");
        resetDevDashboardStorage();
        rmSync(dir, { recursive: true, force: true });
    });

    test("publishes through the same registry as the UI and returns the public URL", async () => {
        const first = await shareNote("Widgets/Design/Note.md");

        expect(first.vaultPath).toBe("Widgets/Design/Note.md");
        expect(first.outcomes).toEqual([{ target: "mac", url: `https://mac.example.com/share/${first.slug}` }]);
        expect(first.slug.length).toBeGreaterThan(8);

        const second = await shareNote(join(vault, "Widgets", "Design", "Note.md"));
        expect(second.slug).toBe(first.slug);
        expect(second.outcomes).toEqual(first.outcomes);
    });

    test("records the targets a note went to, and refuses a target that is not configured", async () => {
        const shared = await shareNote("Widgets/Design/Note.md", ["mac"]);
        const config = await getDevDashboardStorage().getConfig<{ publishedNotes: Array<{ targets?: string[] }> }>();

        expect(config?.publishedNotes[0]?.targets).toBeUndefined();
        const tracked = await findPublication({ kind: "md", id: shared.slug });
        expect(Object.keys(tracked?.syncs ?? {})).toEqual(["mac"]);
        expect(shared.outcomes[0]?.url).toContain("/share/");
        await expect(shareNote("Widgets/Design/Note.md", ["nowhere"])).rejects.toThrow(
            'unknown publish target "nowhere"'
        );
    });

    test("resolves an extensionless path before treating it as a slug", async () => {
        writeFileSync(join(vault, "Weekly.md"), "# Weekly");
        const published = await shareNote("Weekly");
        expect(await resolvePublishedSlug("Weekly")).toBe(published.slug);
        expect(await resolvePublishedSlug(published.slug)).toBe(published.slug);
    });

    test("keeps the implicit live target after a named server is configured beside a vault", async () => {
        await updateShareConfig((config) => ({
            ...config,
            defaults: { server: "desk" },
            servers: [
                {
                    name: "desk",
                    dataDir: join(dir, "data"),
                    stateDir: join(dir, "state"),
                    listen: { host: "127.0.0.1", port: 3944 },
                    publicOrigin: "https://share.example.com",
                    kinds: ["md", "artifact"],
                    minFreeGb: 2,
                    exposure: { kind: "local" },
                    service: { manager: "none" },
                },
            ],
        }));
        expect((await loadSharePublishConfig()).defaults.target).toBe("mac");
    });

    test("returns a note when the optional share ledger cannot be read", async () => {
        await shareNote("Widgets/Design/Note.md");
        writeFileSync(publicationsPath(), "invalid-json");
        const response = await routerToResponse(
            new Router().addAll(obsidianRoutes()),
            new Request("http://localhost/api/obsidian/note?path=Widgets%2FDesign%2FNote.md"),
            { services: { collector: defaultSystemCollector() } }
        );
        expect(response?.status).toBe(200);
        expect(await response?.json()).toMatchObject({ source: "# hi\n", shares: [] });
    });

    test("removes a live target while keeping failed remote removals retryable", async () => {
        const shared = await shareNote("Widgets/Design/Note.md");
        const publication = await findPublication({ kind: "md", id: shared.slug });
        if (!publication) {
            throw new Error("missing fixture publication");
        }

        await updateShareConfig((config) => ({
            ...config,
            targets: [
                ...config.targets,
                {
                    name: "remote",
                    publicBase: "https://share.example.com",
                    transport: {
                        kind: "paired",
                        url: "https://share.example.com",
                        deviceId: "fixture",
                        token: { type: "secure", path: "fixture/unavailable" },
                    },
                },
            ],
        }));
        await savePublication({ ...publication, syncs: { ...publication.syncs, remote: publication.syncs.mac } });
        expect(await unshareFromTargets({ slug: shared.slug, targetNames: ["mac"] })).toEqual([{ target: "mac" }]);
        const retained = await findPublishedBySlug(shared.slug);
        expect(retained?.live).toBe(false);
        expect(await vaultShareSource().findBySlug(shared.slug)).toBeNull();
        expect(retained && (await shareStatusFor(retained)).some((row) => row.live)).toBe(false);

        const response = await routerToResponse(
            new Router().addAll(obsidianRoutes()),
            new Request("http://localhost/api/obsidian/unpublish", {
                method: "POST",
                body: SafeJSON.stringify({ slug: shared.slug }),
            }),
            { services: { collector: defaultSystemCollector() } }
        );
        expect(response?.status).toBe(502);
        expect(await response?.json()).toMatchObject({ error: expect.stringContaining("no token") });
        expect(await findPublishedBySlug(shared.slug)).toBeDefined();
        expect((await findPublication({ kind: "md", id: shared.slug }))?.syncs.remote).toBeDefined();

        await updateShareConfig((config) => ({
            ...config,
            targets: config.targets.map((target) =>
                target.name === "remote"
                    ? { ...target, transport: { kind: "mac-live", mounts: { md: "/share" } } }
                    : target
            ),
        }));
        expect(await unshareFromTargets({ slug: shared.slug, targetNames: [] })).toEqual([{ target: "remote" }]);
        expect(await findPublishedBySlug(shared.slug)).toBeUndefined();
        expect(await findPublication({ kind: "md", id: shared.slug })).toBeUndefined();
    });

    test("fails when the note is missing", async () => {
        await expect(shareNote("Widgets/Design/Missing.md")).rejects.toThrow();
    });
});
