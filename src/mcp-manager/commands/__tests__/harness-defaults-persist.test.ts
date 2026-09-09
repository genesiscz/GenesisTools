import { afterEach, describe, expect, it } from "bun:test";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { setupInquirerMock } from "./inquirer-mock.js";

setupInquirerMock();
setupStorageSandbox();

const { readUnifiedConfig, setGlobalOptions, writeUnifiedConfig } = await import(
    "@app/mcp-manager/utils/config.utils.js"
);

describe("writeUnifiedConfig harness defaults", () => {
    afterEach(() => {
        setGlobalOptions({});
    });

    it("fills default harness homes on first save", async () => {
        setGlobalOptions({ yes: true });

        const written = await writeUnifiedConfig({ mcpServers: {} });
        expect(written).toBe(true);

        const config = await readUnifiedConfig();
        expect(config.harnesses?.codex?.syncTo?.homes).toEqual(["~/.codex"]);
        expect(config.harnesses?.claude?.syncTo?.homes).toEqual(["~/.claude.json"]);
    });
});
