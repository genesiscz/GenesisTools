import { describe, expect, it } from "bun:test";
import { enabledServers, type Registry, type ServerJsonEntry, toServerDefinition } from "./registry.ts";

function server(partial: Partial<ServerJsonEntry> & { name: string }): ServerJsonEntry {
    return { enabled: true, status: "enabled", providers: [], connection: { type: "stdio", command: "x" }, ...partial };
}

describe("toServerDefinition", () => {
    it("maps stdio connections with args and env", () => {
        const definition = toServerDefinition(
            server({ name: "s", connection: { type: "stdio", command: "srv", args: ["--x"], env: { KEY: "v" } } })
        );

        expect(definition?.command).toMatchObject({ kind: "stdio", command: "srv", args: ["--x"] });
        expect(definition?.env).toEqual({ KEY: "v" });
    });

    it("maps http/sse connections and merges extra headers over stored ones", () => {
        const definition = toServerDefinition(
            server({
                name: "r",
                connection: { type: "http", url: "https://mcp.example.com/mcp", headers: { A: "1", B: "stored" } },
            }),
            { B: "override", C: "3" }
        );
        const command = definition?.command as { kind: string; url: URL; headers: Record<string, string> };

        expect(command.kind).toBe("http");
        expect(command.url.href).toBe("https://mcp.example.com/mcp");
        expect(command.headers).toEqual({ A: "1", B: "override", C: "3" });
    });

    it("returns undefined for unknown transports, missing fields and unparsable urls", () => {
        expect(toServerDefinition(server({ name: "u", connection: { type: "unknown" } }))).toBeUndefined();
        expect(toServerDefinition(server({ name: "m", connection: { type: "stdio" } }))).toBeUndefined();
        // One user-authored bad url must not abort the whole definition build.
        expect(
            toServerDefinition(server({ name: "b", connection: { type: "http", url: "not a url" } }))
        ).toBeUndefined();
    });
});

describe("enabledServers", () => {
    it("filters disabled and unknown-transport servers", () => {
        const registry: Registry = {
            servers: [
                server({ name: "on" }),
                server({ name: "off", enabled: false, status: "disabled" }),
                server({ name: "weird", connection: { type: "unknown" } }),
            ],
            providersScanned: [],
            providersFailed: [],
            fetchedAt: "t",
        };

        expect(enabledServers(registry).map((s) => s.name)).toEqual(["on"]);
    });
});
