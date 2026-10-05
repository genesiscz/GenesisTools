import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSessionGc } from "@app/task/lib/gc";
import {
    getTaskSessionsDir,
    isCanonicalSessionJsonlFilename,
    jsonlPath,
    sessionNameFromJsonlFilename,
} from "@app/task/lib/paths";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

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
        expect(sessionNameFromJsonlFilename("web-app.jsonl")).toBe("web-app");
        expect(sessionNameFromJsonlFilename("web-app.ui.jsonl")).toBeNull();
        expect(sessionNameFromJsonlFilename("readme.txt")).toBeNull();
    });
});

// Regression test: a first `tools task run` printed a WARN with a stack trace, because the session
// cleanup read a sessions folder that does not exist until the first session is written
describe("runSessionGc", () => {
    it("treats a missing sessions folder as nothing to clean, without a warning", async () => {
        const original = env.get("GENESIS_TOOLS_HOME");
        const sandbox = mkdtempSync(join(tmpdir(), "gt-gc-"));
        const warn = spyOn(logger, "warn");

        try {
            env.testing.set("GENESIS_TOOLS_HOME", sandbox);
            expect(await runSessionGc({ retentionDays: 7 })).toEqual({ removed: 0 });
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
            rmSync(sandbox, { recursive: true, force: true });

            if (original === undefined) {
                env.testing.unset("GENESIS_TOOLS_HOME");
            } else {
                env.testing.set("GENESIS_TOOLS_HOME", original);
            }
        }
    });
});
