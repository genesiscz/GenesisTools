import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { type LibraryHandle, startLibrary } from "./library";
import { addEntry, removeEntry } from "./registry";
import { resolveTemplateDir } from "./templates";

/**
 * The mount lifecycle only exists through a real request: the entry handoff,
 * the mount cache key and the lazy start all live in `startLibrary`'s http
 * handler, which the mount-cache unit tests deliberately do not touch.
 */

setupStorageSandbox();

let library: LibraryHandle;
let base: string;
const dirs: string[] = [];

function artifactDir(prefix: string, body: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    writeFileSync(join(dir, "notes.md"), body);
    dirs.push(dir);

    return dir;
}

async function get(path: string): Promise<{ status: number; body: string }> {
    const res = await fetch(`${base}${path}`);

    return { status: res.status, body: await res.text() };
}

beforeAll(async () => {
    // Port 0 asks the OS for a free one, so this never fights a real library.
    library = await startLibrary({ port: 0, host: "127.0.0.1", templateDir: resolveTemplateDir(undefined) });
    base = `http://127.0.0.1:${library.port}`;
}, 60_000);

afterAll(async () => {
    await library?.close();

    for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("library server", () => {
    test("the index lists registered folders and does not start a mount", async () => {
        const dir = artifactDir("artifact-lib-index-", "# INDEX_ONLY\n");
        const { name } = addEntry({ dir }).entry;

        const { status, body } = await get("/");
        expect(status).toBe(200);
        expect(body).toContain(name);
        // The listing shows counts, never the artifact's contents: rendering the
        // page must not have booted a Vite server for the folder.
        expect(body).toContain("1 md");
        expect(body).not.toContain("INDEX_ONLY");
    }, 60_000);

    test("an unregistered name 404s", async () => {
        expect((await get("/a/definitely-not-registered/")).status).toBe(404);
    });

    test("a mount serves its folder's artifacts through the clean URL", async () => {
        const dir = artifactDir("artifact-lib-mount-", "# MOUNTED_ONE\n");
        const { name } = addEntry({ dir }).entry;

        const { status, body } = await get(`/a/${name}/notes`);
        expect(status).toBe(200);
        expect(body).toContain("MOUNTED_ONE");
    }, 60_000);

    test("re-registering a name against a NEW directory serves the new one", async () => {
        // The mount cache used to key on the name alone, so the Vite server
        // already rooted at the old path kept answering after the move.
        const before = artifactDir("artifact-lib-move-a-", "# OLD_LOCATION\n");
        const { name } = addEntry({ dir: before, name: "moving-folder" }).entry;
        expect((await get(`/a/${name}/notes`)).body).toContain("OLD_LOCATION");

        removeEntry(name);
        const after = artifactDir("artifact-lib-move-b-", "# NEW_LOCATION\n");
        addEntry({ dir: after, name });

        const { status, body } = await get(`/a/${name}/notes`);
        expect(status).toBe(200);
        expect(body).toContain("NEW_LOCATION");
        expect(body).not.toContain("OLD_LOCATION");
    }, 60_000);
});
