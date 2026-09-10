import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { resolveCodexBinary } from "./codex-binary";

const originalPath = process.env.PATH ?? "";

describe("resolveCodexBinary", () => {
    afterEach(() => {
        env.testing.set("PATH", originalPath);
    });

    test("prefers the codex on the caller's PATH", () => {
        const dir = mkdtempSync(join(tmpdir(), "codex-bin-"));
        const fake = join(dir, "codex");
        writeFileSync(fake, "#!/bin/sh\n");
        chmodSync(fake, 0o755);
        env.testing.set("PATH", dir);

        expect(resolveCodexBinary()).toBe(fake);
    });

    test("with an empty PATH still answers an absolute path or the bare name, never throws", () => {
        env.testing.set("PATH", "");
        const resolved = resolveCodexBinary();

        expect(resolved === "codex" || resolved.startsWith("/")).toBe(true);
    });
});
