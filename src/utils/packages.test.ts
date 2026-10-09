import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import {
    importStorePackage,
    isStorePackageInstalled,
    packageStoreDir,
    STORE_PACKAGES,
} from "@genesiscz/utils/package-store";
import { bunAddCommands, ensurePackages } from "./packages";

const REPO_ROOT = resolve(import.meta.dir, "../..");

/** Writes a package into the (sandboxed) store; `relDir` is relative to its node_modules. */
function writeStorePackage(relDir: string, files: Record<string, string>): void {
    for (const [name, content] of Object.entries(files)) {
        const path = join(packageStoreDir(), "node_modules", relDir, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
    }
}

const MISSING = "__genesis_tools_missing_pkg_for_ensure_packages_test__";

function fakeAddProc(): ReturnType<typeof Bun.spawn> {
    const stderr = new ReadableStream({
        start(controller) {
            controller.close();
        },
    });

    return {
        exited: Promise.resolve(0),
        stderr,
    } as unknown as ReturnType<typeof Bun.spawn>;
}

function isBunAdd(cmd: unknown): boolean {
    return Array.isArray(cmd) && cmd[0] === "bun" && cmd[1] === "add";
}

describe("ensurePackages", () => {
    afterEach(() => {
        mock.restore();
    });

    test("NODE_ENV=test does not spawn bun add", async () => {
        const spawn = spyOn(Bun, "spawn").mockImplementation((cmd) => {
            if (isBunAdd(cmd)) {
                throw new Error("bun add must not run under NODE_ENV=test");
            }

            return fakeAddProc();
        });

        await env.testing.withOverrides({ NODE_ENV: "test" }, async () => {
            await ensurePackages([MISSING], { silent: true });
        });

        expect(spawn.mock.calls.some((call) => isBunAdd(call[0]))).toBe(false);
    });

    test("a non-test env still reaches bun add", async () => {
        const spawn = spyOn(Bun, "spawn").mockImplementation((cmd) => {
            if (isBunAdd(cmd)) {
                return fakeAddProc();
            }

            throw new Error(`unexpected spawn: ${String(cmd)}`);
        });

        await env.testing.withOverrides({ NODE_ENV: "development" }, async () => {
            await ensurePackages([MISSING], { silent: true });
        });

        expect(spawn.mock.calls.some((call) => isBunAdd(call[0]))).toBe(true);
    });

    test("a store package installs into the package store and never runs bun add in the repo", async () => {
        const spawn = spyOn(Bun, "spawn").mockImplementation((cmd) => {
            if (isBunAdd(cmd)) {
                return fakeAddProc();
            }

            throw new Error(`unexpected spawn: ${String(cmd)}`);
        });

        await env.testing.withOverrides({ NODE_ENV: "development" }, async () => {
            await ensurePackages(["@qdrant/js-client-rest"], { silent: true });
        });

        const adds = spawn.mock.calls.filter((call) => isBunAdd(call[0]));
        expect(adds.map((call) => call[1]?.cwd)).toEqual([packageStoreDir()]);
        expect(adds[0]?.[0]).toEqual([
            "bun",
            "add",
            "--exact",
            `@qdrant/js-client-rest@${STORE_PACKAGES["@qdrant/js-client-rest"]}`,
        ]);

        const manifest = readFileSync(join(packageStoreDir(), "package.json"), "utf8");
        expect(manifest).toContain('"@huggingface/transformers"');
        expect(existsSync(join(packageStoreDir(), "bunfig.toml"))).toBe(true);
    });
});

describe("bunAddCommands", () => {
    test("splits store packages from repo packages", () => {
        expect(bunAddCommands(["@lancedb/lancedb", "@ast-grep/lang-python"])).toEqual([
            {
                cwd: packageStoreDir(),
                cmd: ["bun", "add", "--exact", `@lancedb/lancedb@${STORE_PACKAGES["@lancedb/lancedb"]}`],
                store: true,
            },
            { cwd: REPO_ROOT, cmd: ["bun", "add", "@ast-grep/lang-python"], store: false },
        ]);
    });
});

describe("package store", () => {
    afterEach(() => {
        rmSync(join(packageStoreDir(), "node_modules"), { recursive: true, force: true });
    });

    test("a store package counts as installed only at its pinned version", () => {
        expect(isStorePackageInstalled("@lancedb/lancedb")).toBe(false);

        writeStorePackage("@lancedb/lancedb", { "package.json": '{"version": "0.0.1"}' });
        expect(isStorePackageInstalled("@lancedb/lancedb")).toBe(false);

        writeStorePackage("@lancedb/lancedb", {
            "package.json": `{"version": "${STORE_PACKAGES["@lancedb/lancedb"]}"}`,
        });
        expect(isStorePackageInstalled("@lancedb/lancedb")).toBe(true);
    });

    test("importStorePackage loads from the store, and `from` picks that package's own copy", async () => {
        writeStorePackage("gt-fake-dep", {
            "package.json": '{"name": "gt-fake-dep", "main": "index.js"}',
            "index.js": 'module.exports = { copy: "top" };',
        });
        writeStorePackage("gt-fake-parent", { "package.json": '{"name": "gt-fake-parent"}' });
        writeStorePackage("gt-fake-parent/node_modules/gt-fake-dep", {
            "package.json": '{"name": "gt-fake-dep", "main": "index.js"}',
            "index.js": 'module.exports = { copy: "nested" };',
        });

        const top = await importStorePackage<{ copy: string }>("gt-fake-dep");
        const nested = await importStorePackage<{ copy: string }>("gt-fake-dep", { from: "gt-fake-parent" });

        expect(top.copy).toBe("top");
        expect(nested.copy).toBe("nested");
    });

    test("a package missing from the store fails with an error that names the store", async () => {
        await expect(importStorePackage("gt-fake-absent")).rejects.toThrow(packageStoreDir());
    });
});
