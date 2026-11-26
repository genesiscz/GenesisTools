import { expect, test } from "bun:test";
import type { ShareServerConfig } from "../../genesis-tools/publish/store";
import { proxySnippet } from "../exposure";
import { SERVICE_INSTALLERS } from "./index";
import type { ServiceUnitInput } from "./types";

const server: ShareServerConfig = {
    name: "desk",
    dataDir: "/srv/share/data",
    stateDir: "/srv/share/state",
    listen: { host: "127.0.0.1", port: 3944 },
    publicOrigin: "https://share.example.com",
    kinds: ["md", "artifact"],
    minFreeGb: 2,
    exposure: { kind: "reverse-proxy", proxy: "apache" },
    service: { manager: "none" },
};
const input: ServiceUnitInput = { server, checkoutDir: "/srv/project", bunPath: "/usr/bin/bun", home: "/home/desk" };

test("service renderers use the same config-based serve invocation", () => {
    const linux = {
        ...input,
        server: { ...server, service: { manager: "systemd" as const, user: "desk", unit: "fixture.service" } },
    };
    const unit = SERVICE_INSTALLERS.systemd.render(linux);
    expect(unit).toContain("User=desk\n");
    expect(unit).toContain(
        "ExecStart=/usr/bin/bun /srv/project/src/dev-dashboard/index.ts share-server serve --server desk"
    );
    expect(unit).toContain("Environment=HOME=/home/desk\n");
    expect(unit).toContain("Environment=GENESIS_TOOLS_HOME=/home/desk\n");
    expect(SERVICE_INSTALLERS.systemd.installCommands({ ...linux, unitFile: "/tmp/fixture.service" })[1]).toEqual([
        "systemctl",
        "daemon-reload",
    ]);

    const mac = { ...input, server: { ...server, service: { manager: "launchd" as const, label: "dev.fixture" } } };
    const plist = SERVICE_INSTALLERS.launchd.render(mac);
    expect(plist).toContain(
        "<string>share-server</string>\n    <string>serve</string>\n    <string>--server</string>\n    <string>desk</string>"
    );
    expect(plist).toContain("<key>GENESIS_TOOLS_HOME</key><string>/home/desk</string>");
    expect(SERVICE_INSTALLERS.none.render(input)).toBe("");
    expect(SERVICE_INSTALLERS.none.installCommands({ ...input, unitFile: "" })).toEqual([]);
});

test("proxy snippets forward the chosen origin to the configured listener", () => {
    expect(proxySnippet({ proxy: "apache", server })).toContain('ProxyPass "/" "http://127.0.0.1:3944/"');
    expect(proxySnippet({ proxy: "nginx", server })).toContain("proxy_pass http://127.0.0.1:3944;");
    expect(proxySnippet({ proxy: "caddy", server })).toContain(
        "share.example.com {\n    reverse_proxy http://127.0.0.1:3944"
    );
});
