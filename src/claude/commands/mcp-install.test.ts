import { describe, expect, it } from "bun:test";
import { buildInstallArgs } from "@app/genesis-tools-mcp/lib/mcp-install";

describe("buildInstallArgs", () => {
    it("targets the claude provider with a stdio command by default", () => {
        const a = buildInstallArgs({});
        expect(a.serverName).toBe("genesis-tools");
        expect(a.options.type).toBe("stdio");
        expect(a.options.provider).toBe("claude");
        expect(a.commandOrUrl).toBe("tools genesis-tools-mcp");
    });

    it("targets codex when --agent codex", () => {
        expect(buildInstallArgs({ agent: "codex" }).options.provider).toBe("codex");
    });
});
