import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import {
    enabledServers,
    loadRegistry,
    REGISTRY_SCHEMA,
    type Registry,
    type ServerJsonEntry,
    toServerDefinition,
} from "./registry.ts";

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

describe("registry cache versioning", () => {
    /**
     * A cache written before gateway servers existed holds the UPSTREAM url, or a
     * redacted placeholder header. Consumed on a cache hit, createKit either dials the
     * upstream directly — bypassing the gateway that holds the token — or sends `•••`
     * and gets a 401. Both read as a transport bug rather than a stale file, which is
     * why the file has to say which rules it was written under.
     */
    it("treats a cache without the current schema as a miss", async () => {
        const home = mkdtempSync(join(tmpdir(), "gt-registry-"));
        env.testing.set("GENESIS_TOOLS_HOME", home);

        try {
            // A sentinel name no provider config on any machine can produce, so its
            // absence after the load proves the stale file was NOT returned. Asserting
            // on a real server name would fail for the wrong reason: the rebuild reads
            // the machine's actual provider configs, which legitimately contain them.
            const stale: Registry = {
                servers: [
                    {
                        name: "stale-cache-sentinel-do-not-use",
                        enabled: true,
                        status: "enabled",
                        providers: [],
                        connection: { type: "http", url: "https://stale.invalid/mcp" },
                    },
                ],
                providersScanned: [],
                providersFailed: [],
                fetchedAt: new Date().toISOString(),
            };
            const cacheHome = join(home, ".genesis-tools", "scripts", "cache");
            mkdirSync(cacheHome, { recursive: true, mode: 0o700 });
            atomicWriteFileSync(
                join(cacheHome, "registry.json"),
                `${SafeJSON.stringify(stale, { strict: true }, 2)}\n`,
                {
                    mode: 0o600,
                }
            );

            // persist:false so this stays a read and cannot mint a gateway token.
            const loaded = await loadRegistry({ persist: false });

            // Rebuilt from the providers, so it carries the current schema and NOT the
            // sentinel that only the stale file contained.
            expect(loaded.schema).toBe(REGISTRY_SCHEMA);
            expect(loaded.servers.some((s) => s.name === "stale-cache-sentinel-do-not-use")).toBe(false);
        } finally {
            env.testing.unset("GENESIS_TOOLS_HOME");
        }
    });

    it("pins the current schema number so a shape change has to bump it deliberately", () => {
        expect(REGISTRY_SCHEMA).toBe(2);
    });
});
