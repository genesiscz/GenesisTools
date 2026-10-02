import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRecordPath, refreshInstallRecord } from "@genesiscz/utils/install-record";
import { findGenesisTools } from "./locate-genesis-tools.ts";

const saved = { ...process.env };
afterEach(() => {
    for (const key of ["GENESIS_TOOLS_HOME", "GENESIS_TOOLS_PATH", "GENESIS_TOOLS_ROOT"]) {
        if (saved[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = saved[key];
        }
    }
});

/** A fake checkout: the package name, a `typescript` in node_modules, and a `.git` of the given kind. */
const checkout = (git: "dir" | "file"): string => {
    const root = mkdtempSync(join(tmpdir(), "gt-locate-"));
    writeFileSync(join(root, "package.json"), '{ "name": "@genesiscz/tools", "version": "9.9.9" }\n');
    mkdirSync(join(root, "node_modules", "typescript"), { recursive: true });
    writeFileSync(join(root, "node_modules", "typescript", "package.json"), '{ "name": "typescript" }\n');
    if (git === "dir") {
        mkdirSync(join(root, ".git"));
    } else {
        writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n");
    }
    return root;
};

describe("finding the GenesisTools checkout from a plugin copy", () => {
    test("every tools run records the main checkout, and the locator finds it there first", () => {
        process.env.GENESIS_TOOLS_HOME = mkdtempSync(join(tmpdir(), "gt-locate-home-"));
        delete process.env.GENESIS_TOOLS_PATH;
        delete process.env.GENESIS_TOOLS_ROOT;
        const root = checkout("dir");

        refreshInstallRecord(root);
        expect(JSON.parse(readFileSync(installRecordPath(), "utf8"))).toMatchObject({
            checkout: root,
            version: "9.9.9",
        });
        expect(findGenesisTools()).toEqual({ root, via: "install-record" });
    });

    test("a linked worktree never becomes the recorded install", () => {
        process.env.GENESIS_TOOLS_HOME = mkdtempSync(join(tmpdir(), "gt-locate-home-"));
        refreshInstallRecord(checkout("file"));
        expect(() => readFileSync(installRecordPath(), "utf8")).toThrow();
    });

    test("GENESIS_TOOLS_PATH wins, and a folder that is not a checkout is skipped", () => {
        process.env.GENESIS_TOOLS_HOME = mkdtempSync(join(tmpdir(), "gt-locate-home-"));
        const root = checkout("dir");
        process.env.GENESIS_TOOLS_PATH = root;
        expect(findGenesisTools()).toEqual({ root, via: "env" });

        process.env.GENESIS_TOOLS_PATH = mkdtempSync(join(tmpdir(), "gt-not-a-checkout-"));
        expect(findGenesisTools()?.via).not.toBe("env");
    });
});
