import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    getTaskSessionsDir,
    isCanonicalSessionJsonlFilename,
    jsonlPath,
    sessionNameFromJsonlFilename,
} from "@app/task/lib/paths";
import { env } from "@app/utils/env";

describe("task paths", () => {
    const originalHome = env.get("GENESIS_TOOLS_HOME");
    const dirs: string[] = [];

    afterEach(() => {
        if (originalHome === undefined) {
            env.testing.unset("GENESIS_TOOLS_HOME");
        } else {
            env.testing.set("GENESIS_TOOLS_HOME", originalHome);
        }

        for (const dir of dirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("resolves sessions dir from GENESIS_TOOLS_HOME at call time", () => {
        const sandbox = mkdtempSync(join(tmpdir(), "gt-paths-"));
        dirs.push(sandbox);
        env.testing.set("GENESIS_TOOLS_HOME", sandbox);

        expect(getTaskSessionsDir()).toBe(join(sandbox, ".genesis-tools", "task", "sessions"));
        expect(jsonlPath("foo")).toBe(join(sandbox, ".genesis-tools", "task", "sessions", "foo.jsonl"));
    });

    it("follows GENESIS_TOOLS_HOME changes without re-importing", () => {
        const first = mkdtempSync(join(tmpdir(), "gt-paths-a-"));
        const second = mkdtempSync(join(tmpdir(), "gt-paths-b-"));
        dirs.push(first, second);

        env.testing.set("GENESIS_TOOLS_HOME", first);
        expect(getTaskSessionsDir()).toBe(join(first, ".genesis-tools", "task", "sessions"));

        env.testing.set("GENESIS_TOOLS_HOME", second);
        expect(getTaskSessionsDir()).toBe(join(second, ".genesis-tools", "task", "sessions"));
    });

    it("recognizes canonical session jsonl filenames", () => {
        expect(isCanonicalSessionJsonlFilename("metro.jsonl")).toBe(true);
        expect(isCanonicalSessionJsonlFilename("metro.ui.jsonl")).toBe(false);
        expect(isCanonicalSessionJsonlFilename("foo.meta.json")).toBe(false);
    });

    it("derives session name only from canonical jsonl files", () => {
        expect(sessionNameFromJsonlFilename("col-fe.jsonl")).toBe("col-fe");
        expect(sessionNameFromJsonlFilename("col-fe.ui.jsonl")).toBeNull();
        expect(sessionNameFromJsonlFilename("readme.txt")).toBeNull();
    });
});
