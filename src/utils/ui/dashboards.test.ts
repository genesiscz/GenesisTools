import { describe, expect, test } from "bun:test";
import {
    DASHBOARDS,
    findPortConflicts,
    listPortRegistry,
    matchAll,
    matchGenesisTool,
    matchRegistryProcess,
    registryEntryForPort,
    registryNameForProcess,
    WEB_SERVICES,
} from "./dashboards";

describe("port registry", () => {
    test("no port conflicts across dashboards + web services", () => {
        expect(findPortConflicts()).toEqual([]);
    });

    test("every entry has a unique port and matchProcess", () => {
        const ports = new Set<number>();
        for (const e of listPortRegistry()) {
            expect(typeof e.matchProcess).toBe("function");
            expect(ports.has(e.port)).toBe(false);
            ports.add(e.port);
        }

        expect(ports.size).toBe(listPortRegistry().length);
    });

    test("web services cover youtube server/extension and ai-proxy", () => {
        expect(WEB_SERVICES["youtube-server"].port).toBe(9876);
        expect(WEB_SERVICES["youtube-extension"].port).toBe(9877);
        expect(WEB_SERVICES["ai-proxy"].port).toBe(8317);
        expect(registryEntryForPort(9876)?.name).toBe("YouTube Server");
    });
});

describe("matchProcess", () => {
    test("dev-dashboard matches only when process is under repo", () => {
        const entry = DASHBOARDS["dev-dashboard"];
        expect(
            entry.matchProcess({
                port: 3042,
                command: "bun",
                fullCommand: "bun …/GenesisTools/src/dev-dashboard/index.ts",
                cwd: "/Users/Martin/Tresors/Projects/GenesisTools",
            })
        ).toBe(true);

        expect(
            entry.matchProcess({
                port: 3042,
                command: "python",
                fullCommand: "python -m http.server",
                cwd: "/tmp/other",
            })
        ).toBe(false);
    });

    test("youtube-server rejects unrelated process on 9876", () => {
        const entry = WEB_SERVICES["youtube-server"];
        expect(
            entry.matchProcess({
                port: 9876,
                command: "node",
                fullCommand: "node /tmp/random-server.js",
                cwd: "/tmp",
            })
        ).toBe(false);

        expect(
            entry.matchProcess({
                port: 9876,
                command: "bun",
                fullCommand: "bun run /Users/x/GenesisTools/src/youtube/lib/server/index.ts",
                cwd: "/Users/x/GenesisTools",
            })
        ).toBe(true);
    });

    test("matchRegistryProcess requires port + process", () => {
        expect(
            matchRegistryProcess({
                port: 9877,
                command: "bun",
                fullCommand: "bun …/GenesisTools/src/youtube/index.ts extension dev",
                cwd: "/Users/x/GenesisTools",
            })?.key
        ).toBe("youtube-extension");

        expect(
            matchRegistryProcess({
                port: 9877,
                command: "python",
                fullCommand: "python -m http.server 9877",
                cwd: "/tmp",
            })
        ).toBeNull();

        expect(registryNameForProcess({ port: 8317, command: "bun", cwd: "/tmp" })).toBeNull();
        expect(
            registryNameForProcess({
                port: 8317,
                command: "bun",
                fullCommand: "bun run src/ai-proxy/index.ts serve",
                cwd: "/Users/x/GenesisTools",
            })
        ).toBe("AI Proxy");
    });
});

describe("match helpers", () => {
    test("matchAll / matchGenesisTool", () => {
        expect(matchAll("a", "b")({ port: 1, command: "x", fullCommand: "a b c" })).toBe(true);
        expect(matchAll("a", "z")({ port: 1, command: "x", fullCommand: "a b c" })).toBe(false);
        expect(matchGenesisTool("youtube")({ port: 1, command: "bun", cwd: "/tmp" })).toBe(false);
    });
});
