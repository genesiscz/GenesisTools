import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computerUseLaunchOverrides, computerUseOverrides } from "./computer-use";

test("Computer Use launch adds Sky without editing desktop-owned configuration", () => {
    const home = mkdtempSync(join(tmpdir(), "gt-sky-config-"));
    const resources = join(home, "resources");
    const bin = join(resources, "cua_node/bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "node_repl"), "fixture");
    writeFileSync(join(bin, "node"), "fixture");
    mkdirSync(join(home, "computer-use/Codex Computer Use.app"), { recursive: true });
    const original = '[mcp_servers.node_repl.env]\nNODE_REPL_TRUSTED_SERVICES = \'{"browser":"/browser.mjs"}\'\n';
    writeFileSync(join(home, "config.toml"), original);
    const overrides = computerUseOverrides({ home, resourcesPath: resources });
    expect(
        overrides.find((value) => value.startsWith("mcp_servers.node_repl.env.NODE_REPL_TRUSTED_SERVICES="))
    ).toContain("sky");
    expect(
        overrides.find((value) => value.startsWith("mcp_servers.node_repl.env.NODE_REPL_TRUSTED_SERVICES="))
    ).toContain("/browser.mjs");
    expect(overrides.find((value) => value.startsWith("mcp_servers.node_repl.env.SKY_CUA_SERVICE_PATH="))).toContain(
        home
    );
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(original);
});

test("missing native installation is reported before a server starts", () => {
    expect(() => computerUseOverrides({ home: "/missing-home", resourcesPath: "/missing-runtime" })).toThrow(
        "installed"
    );
});

test("an installed native runtime is enabled automatically with an explicit opt-out", () => {
    const home = mkdtempSync(join(tmpdir(), "gt-sky-auto-"));
    const resourcesPath = join(home, "resources");
    mkdirSync(join(resourcesPath, "cua_node/bin"), { recursive: true });
    for (const file of ["node", "node_repl"]) {
        writeFileSync(join(resourcesPath, "cua_node/bin", file), "fixture");
    }
    mkdirSync(join(home, "computer-use/Codex Computer Use.app"), { recursive: true });
    expect(computerUseLaunchOverrides({ home, resourcesPath })).toContain("features.computer_use=true");
    expect(computerUseLaunchOverrides({ home, resourcesPath, enabled: false })).toEqual([]);
    expect(computerUseLaunchOverrides({ home: "/missing-home", resourcesPath: "/missing-runtime" })).toEqual([]);
    expect(() =>
        computerUseLaunchOverrides({ home: "/missing-home", resourcesPath: "/missing-runtime", enabled: true })
    ).toThrow("installed");
});
