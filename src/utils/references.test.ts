import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { RefStoreManager } from "./references";

describe("RefStoreManager concurrent formatValue calls", () => {
    let previousHome: string | undefined;
    let homeDir: string;

    beforeEach(() => {
        previousHome = env.get("GENESIS_TOOLS_HOME");
        homeDir = mkdtempSync(join(tmpdir(), "refs-test-"));
        env.testing.set("GENESIS_TOOLS_HOME", homeDir);
    });

    afterEach(() => {
        if (previousHome === undefined) {
            env.testing.unset("GENESIS_TOOLS_HOME");
        } else {
            env.testing.set("GENESIS_TOOLS_HOME", previousHome);
        }
        rmSync(homeDir, { recursive: true, force: true });
    });

    test("two interleaved formatValue calls for the same session both persist their ref entries", async () => {
        const sessionId = "test-session-hash";
        const manager1 = new RefStoreManager("har-analyzer", sessionId);
        const manager2 = new RefStoreManager("har-analyzer", sessionId);

        const longValue = (tag: string) => `${"a".repeat(210)}-${tag}`;

        await Promise.all([
            manager1.formatValue(longValue("one"), "ref-one"),
            manager2.formatValue(longValue("two"), "ref-two"),
        ]);

        const fresh = new RefStoreManager("har-analyzer", sessionId);
        const loaded = await fresh.load();

        expect(loaded.refs["ref-one"]).toBeTruthy();
        expect(loaded.refs["ref-two"]).toBeTruthy();
    });
});
