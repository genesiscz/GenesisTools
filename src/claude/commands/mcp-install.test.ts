import { describe, expect, it } from "bun:test";
import { buildInstallArgs } from "./mcp-install";

describe("buildInstallArgs", () => {
    it("targets the claude provider with a stdio command by default", () => {
        const a = buildInstallArgs({});
        expect(a.serverName).toBe("genesis-tools");
        expect(a.options.type).toBe("stdio");
        expect(a.options.provider).toBe("claude");
        expect(a.commandOrUrl).toContain("claude mcp");
    });

    it("targets codex when --agent codex", () => {
        expect(buildInstallArgs({ agent: "codex" }).options.provider).toBe("codex");
    });
});
