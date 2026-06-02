import { describe, expect, it } from "bun:test";
import {
    buildConfigYaml,
    buildCreateArgs,
    buildRouteDnsArgs,
    buildRunArgs,
    parseTunnelId,
} from "@app/dev-dashboard/lib/tunnel/cloudflared";

describe("cloudflared arg builders", () => {
    it("creates a named tunnel", () => {
        expect(buildCreateArgs("devdashboard")).toEqual(["tunnel", "create", "devdashboard"]);
    });

    it("routes DNS to a hostname", () => {
        expect(buildRouteDnsArgs("devdashboard", "mac.example.com")).toEqual([
            "tunnel",
            "route",
            "dns",
            "devdashboard",
            "mac.example.com",
        ]);
    });

    it("runs a tunnel pointed at a local port via --url", () => {
        expect(buildRunArgs("devdashboard", 3042)).toEqual([
            "tunnel",
            "run",
            "--url",
            "http://127.0.0.1:3042",
            "devdashboard",
        ]);
    });

    it("parses the tunnel id out of `tunnel create` stdout", () => {
        const out = "Created tunnel devdashboard with id 6ff42ae2-765d-4adf-8112-31c55c1551ef";
        expect(parseTunnelId(out)).toBe("6ff42ae2-765d-4adf-8112-31c55c1551ef");
    });

    it("returns null when no id is present", () => {
        expect(parseTunnelId("nothing here")).toBeNull();
    });
});

describe("buildConfigYaml", () => {
    it("maps a public hostname to the local port with a 404 fallthrough", () => {
        const yaml = buildConfigYaml({
            tunnelId: "6ff42ae2-765d-4adf-8112-31c55c1551ef",
            credentialsFile: "/Users/martin/.cloudflared/6ff42ae2-765d-4adf-8112-31c55c1551ef.json",
            hostname: "mac.example.com",
            localPort: 3042,
        });

        expect(yaml).toBe(
            [
                "tunnel: 6ff42ae2-765d-4adf-8112-31c55c1551ef",
                "credentials-file: /Users/martin/.cloudflared/6ff42ae2-765d-4adf-8112-31c55c1551ef.json",
                "ingress:",
                "  - hostname: mac.example.com",
                "    service: http://127.0.0.1:3042",
                "  - service: http_status:404",
                "",
            ].join("\n")
        );
    });
});
