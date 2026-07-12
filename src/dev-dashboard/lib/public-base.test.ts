import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";
import { boardPageUrl, publicBaseUrl } from "./public-base";

describe("publicBaseUrl", () => {
    let dir = "";

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "public-base-"));
        env.testing.set("GENESIS_TOOLS_HOME", dir);
        resetDevDashboardStorage();
    });

    afterEach(() => {
        env.testing.unset("GENESIS_TOOLS_HOME");
        resetDevDashboardStorage();
        rmSync(dir, { recursive: true, force: true });
    });

    function writeConfig(config: Record<string, unknown>): void {
        const toolDir = join(dir, ".genesis-tools", "dev-dashboard");
        mkdirSync(toolDir, { recursive: true });
        writeFileSync(join(toolDir, "config.json"), SafeJSON.stringify(config));
    }

    it("uses https on the first allowed host when a public host is configured", async () => {
        writeConfig({ port: 4555, allowedHosts: ["mac.example.dev"] });
        expect(await publicBaseUrl()).toBe("https://mac.example.dev");
        expect(await boardPageUrl("my-board")).toBe("https://mac.example.dev/boards/my-board");
    });

    it("falls back to the local listener without a public host", async () => {
        writeConfig({ port: 4555, allowedHosts: [] });
        expect(await publicBaseUrl()).toBe("http://localhost:4555");
    });

    it("treats a localhost allowed host as local", async () => {
        writeConfig({ port: 4555, allowedHosts: ["localhost"] });
        expect(await publicBaseUrl()).toBe("http://localhost:4555");
    });
});
