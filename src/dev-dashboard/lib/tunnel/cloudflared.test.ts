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
        const out = "Created tunnel devdashboard with id 00000000-1111-2222-3333-444444444444";
        expect(parseTunnelId(out)).toBe("00000000-1111-2222-3333-444444444444");
    });

    it("returns null when no id is present", () => {
        expect(parseTunnelId("nothing here")).toBeNull();
    });
});

describe("buildConfigYaml", () => {
    it("maps a public hostname to the local port with a 404 fallthrough", () => {
        const yaml = buildConfigYaml({
            tunnelId: "00000000-1111-2222-3333-444444444444",
            credentialsFile: "/Users/Martin/.cloudflared/00000000-1111-2222-3333-444444444444.json",
            hostname: "mac.example.com",
            localPort: 3042,
        });

        expect(yaml).toBe(
            [
                "tunnel: 00000000-1111-2222-3333-444444444444",
                "credentials-file: /Users/Martin/.cloudflared/00000000-1111-2222-3333-444444444444.json",
                "ingress:",
                "  - hostname: mac.example.com",
                "    service: http://127.0.0.1:3042",
                "  - service: http_status:404",
                "",
            ].join("\n")
        );
    });
});
