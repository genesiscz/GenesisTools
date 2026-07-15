import { describe, expect, test } from "bun:test";
import {
    deriveTitle,
    deriveVisibility,
    filterPortsByKind,
    isVerifiedGenesisTools,
    kindFromProbe,
    parseCursorWorkspace,
    sortPorts,
    splitVisibility,
} from "./classify";
import type { PortInfo } from "./types";

describe("parseCursorWorkspace", () => {
    test("extracts extension-host workspace label", () => {
        expect(parseCursorWorkspace("Cursor Helper (Plugin): extension-host (user) GenesisPlayground [3-14]")).toBe(
            "Cursor · GenesisPlayground [3-14]"
        );
    });

    test("null for non-Cursor", () => {
        expect(parseCursorWorkspace("node /app/vite")).toBeNull();
    });
});

describe("deriveVisibility", () => {
    test("ControlCenter is system", () => {
        expect(
            deriveVisibility({
                port: 5000,
                command: "ControlCenter",
                fullCommand: "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter",
            })
        ).toBe("system");
    });

    test("Cursor extension-host is junk", () => {
        expect(
            deriveVisibility({
                port: 56639,
                command: "Cursor",
                fullCommand: "Cursor Helper (Plugin): extension-host (user) col-be [4-31]",
            })
        ).toBe("junk");
    });

    test("normal node web stays normal", () => {
        expect(
            deriveVisibility({
                port: 5173,
                command: "node",
                fullCommand: "node node_modules/.bin/vite",
                cwd: "/Users/x/app",
            })
        ).toBe("normal");
    });
});

describe("isVerifiedGenesisTools (registry + matchProcess)", () => {
    test("dev-dashboard port + matching process", () => {
        expect(
            isVerifiedGenesisTools(
                3042,
                "bun run /Users/Martin/Tresors/Projects/GenesisTools/src/dev-dashboard/index.ts",
                "/Users/Martin/Tresors/Projects/GenesisTools",
                "bun"
            )
        ).toBe(true);
    });

    test("registered port alone is not enough", () => {
        expect(isVerifiedGenesisTools(3042, "python -m http.server", "/tmp/other", "python")).toBe(false);
    });

    test("youtube server / extension from WEB_SERVICES", () => {
        expect(
            isVerifiedGenesisTools(
                9876,
                "bun run /Users/Martin/Tresors/Projects/GenesisTools/src/youtube/lib/server/index.ts",
                "/Users/Martin/Tresors/Projects/GenesisTools",
                "bun"
            )
        ).toBe(true);
        expect(
            isVerifiedGenesisTools(
                9877,
                "bun /Users/Martin/Tresors/Projects/GenesisTools/src/youtube/index.ts extension dev",
                "/Users/Martin/Tresors/Projects/GenesisTools",
                "bun"
            )
        ).toBe(true);
    });

    test("ai-proxy from WEB_SERVICES", () => {
        expect(
            isVerifiedGenesisTools(
                8317,
                "bun run src/ai-proxy/index.ts serve --port 8317",
                "/Users/Martin/Tresors/Projects/GenesisTools",
                "bun"
            )
        ).toBe(true);
    });

    test("unregistered port is never GenesisTools even under monorepo cwd", () => {
        expect(
            isVerifiedGenesisTools(55555, "bun run something", "/Users/Martin/Tresors/Projects/GenesisTools", "bun")
        ).toBe(false);
    });
});

describe("kindFromProbe", () => {
    test("html → web", () => {
        expect(kindFromProbe({ isGenesisTools: false, http: true, contentClass: "html" })).toEqual({
            kind: "web",
            isWebapp: true,
        });
    });

    test("json → api", () => {
        expect(kindFromProbe({ isGenesisTools: false, http: true, contentClass: "json" }).kind).toBe("api");
    });

    test("genesis-tools wins over html", () => {
        expect(kindFromProbe({ isGenesisTools: true, http: true, contentClass: "html" }).kind).toBe("genesis-tools");
    });
});

describe("filterPortsByKind", () => {
    const base = {
        pid: 1,
        command: "node",
        address: "127.0.0.1",
        proto: "tcp4" as const,
        visibility: "normal" as const,
        probeStatus: "done" as const,
    };

    const ports: PortInfo[] = [
        { ...base, port: 1, kind: "web", isWebapp: true, title: "a" },
        { ...base, port: 2, kind: "api", title: "b" },
        { ...base, port: 3, kind: "other", title: "c" },
        { ...base, port: 4, kind: "genesis-tools", isGenesisTools: true, title: "d" },
    ];

    test("all keeps everything", () => {
        expect(filterPortsByKind(ports, ["all"])).toHaveLength(4);
    });

    test("web + apis excludes other (≠ all)", () => {
        const r = filterPortsByKind(ports, ["web", "apis"]);
        expect(r.map((p) => p.port).sort()).toEqual([1, 2]);
    });

    test("genesis-tools filter", () => {
        expect(filterPortsByKind(ports, ["genesis-tools"]).map((p) => p.port)).toEqual([4]);
    });

    test("genesis-tools matches isGenesisTools even while probe pending", () => {
        const mixed: PortInfo[] = [
            {
                ...base,
                port: 3042,
                isGenesisTools: true,
                kind: "genesis-tools",
                probeStatus: "pending",
                title: "Dev Dashboard",
            },
            { ...base, port: 5173, probeStatus: "pending", title: "vite" },
        ];
        expect(filterPortsByKind(mixed, ["genesis-tools"]).map((p) => p.port)).toEqual([3042]);
    });

    test("pending alone does not match genesis-tools", () => {
        const mixed: PortInfo[] = [{ ...base, port: 9, probeStatus: "pending", title: "noise" }];
        expect(filterPortsByKind(mixed, ["genesis-tools"])).toEqual([]);
    });
});

describe("sortPorts / splitVisibility", () => {
    test("sort by port desc", () => {
        const ports: PortInfo[] = [
            { port: 10, pid: 1, command: "a", address: "*", proto: "tcp4" },
            { port: 20, pid: 2, command: "b", address: "*", proto: "tcp4" },
        ];
        expect(sortPorts(ports, "port", "desc").map((p) => p.port)).toEqual([20, 10]);
    });

    test("split hides system and junk", () => {
        const ports: PortInfo[] = [
            { port: 1, pid: 1, command: "a", address: "*", proto: "tcp4", visibility: "normal" },
            { port: 2, pid: 2, command: "b", address: "*", proto: "tcp4", visibility: "system" },
            { port: 3, pid: 3, command: "c", address: "*", proto: "tcp4", visibility: "junk" },
        ];
        const { normal, hidden } = splitVisibility(ports);
        expect(normal).toHaveLength(1);
        expect(hidden).toHaveLength(2);
    });
});

describe("deriveTitle", () => {
    test("Cursor workspace title", () => {
        expect(
            deriveTitle({
                port: 99,
                command: "Cursor",
                fullCommand: "Cursor Helper (Plugin): extension-host (user) col-be [4-31]",
            })
        ).toBe("Cursor · col-be [4-31]");
    });

    test("registry name for matched youtube server", () => {
        expect(
            deriveTitle({
                port: 9876,
                command: "bun",
                fullCommand: "bun run /Users/Martin/Tresors/Projects/GenesisTools/src/youtube/lib/server/index.ts",
                cwd: "/Users/Martin/Tresors/Projects/GenesisTools",
            })
        ).toBe("YouTube Server");
    });
});
