import { describe, expect, test } from "bun:test";
import {
    dashboardNameForPort,
    isGenericRuntime,
    isLocalAddress,
    parseHtmlTitle,
    parseLsofCwd,
    parsePackageName,
} from "./enrich";
import type { PortInfo } from "./types";
import { selectWebapps } from "./webapps";

describe("isGenericRuntime", () => {
    test("matches known runtimes case-insensitively", () => {
        expect(isGenericRuntime("bun")).toBe(true);
        expect(isGenericRuntime("node")).toBe(true);
        expect(isGenericRuntime("php-fpm")).toBe(true);
        expect(isGenericRuntime("Python3")).toBe(true);
    });

    test("leaves named apps alone", () => {
        expect(isGenericRuntime("OrbStack")).toBe(false);
        expect(isGenericRuntime("rapportd")).toBe(false);
        expect(isGenericRuntime("SetappAgent")).toBe(false);
    });
});

describe("isLocalAddress", () => {
    test("accepts loopback and wildcard binds", () => {
        for (const addr of ["127.0.0.1", "[::1]", "::1", "*", "0.0.0.0", "localhost"]) {
            expect(isLocalAddress(addr)).toBe(true);
        }
    });

    test("rejects a specific LAN address", () => {
        expect(isLocalAddress("192.168.1.42")).toBe(false);
    });
});

describe("parsePackageName", () => {
    test("returns the trimmed name", () => {
        expect(parsePackageName('{ "name": "  my-app  ", "version": "1.0.0" }')).toBe("my-app");
    });

    test("tolerates JSONC comments and trailing commas (SafeJSON)", () => {
        expect(parsePackageName('{\n  // the app\n  "name": "commented",\n}')).toBe("commented");
    });

    test("null on missing/empty name or invalid json", () => {
        expect(parsePackageName('{ "version": "1.0.0" }')).toBeNull();
        expect(parsePackageName('{ "name": "   " }')).toBeNull();
        expect(parsePackageName("not json")).toBeNull();
    });
});

describe("parseHtmlTitle", () => {
    test("extracts and collapses whitespace", () => {
        expect(parseHtmlTitle("<html><head><title>  My\n  Dashboard </title></head>")).toBe("My Dashboard");
    });

    test("handles attributes on the title tag", () => {
        expect(parseHtmlTitle('<title data-x="1">Vite App</title>')).toBe("Vite App");
    });

    test("null when absent or empty", () => {
        expect(parseHtmlTitle("<html><body>no title</body></html>")).toBeNull();
        expect(parseHtmlTitle("<title>   </title>")).toBeNull();
    });
});

describe("parseLsofCwd", () => {
    test("returns the n-field path", () => {
        const out = ["p1321", "fcwd", "n/Users/Martin/Projects/foo", ""].join("\n");
        expect(parseLsofCwd(out)).toBe("/Users/Martin/Projects/foo");
    });

    test("null when no n-field present", () => {
        expect(parseLsofCwd("p1321\nfcwd\n")).toBeNull();
    });
});

describe("dashboardNameForPort", () => {
    test("resolves known repo dashboards by their registry port", () => {
        expect(dashboardNameForPort(3042)).toBe("Dev Dashboard");
        expect(dashboardNameForPort(3074)).toBe("YouTube Web UI");
        expect(dashboardNameForPort(7243)).toBe("Log Viewer (dbg + task)");
    });

    test("null for an unregistered port", () => {
        expect(dashboardNameForPort(54321)).toBeNull();
    });
});

describe("selectWebapps", () => {
    const base = { pid: 100, command: "bun", address: "127.0.0.1" } as const;

    test("keeps only HTTP responders, collapses tcp4/tcp6, sorts by port", () => {
        const ports: PortInfo[] = [
            { ...base, port: 5173, proto: "tcp6", isWebapp: true, title: "web-v6" },
            { ...base, port: 5173, proto: "tcp4", isWebapp: true, title: "web-v4" },
            { ...base, port: 3000, proto: "tcp4", isWebapp: true, title: "api" },
            { ...base, port: 5432, proto: "tcp4", isWebapp: false },
        ];

        const result = selectWebapps(ports);
        expect(result.map((p) => p.port)).toEqual([3000, 5173]);
        expect(result.find((p) => p.port === 5173)?.proto).toBe("tcp4");
        expect(result.some((p) => p.port === 5432)).toBe(false);
    });

    test("falls back to tcp6 when no tcp4 row exists", () => {
        const ports: PortInfo[] = [{ ...base, port: 8080, proto: "tcp6", isWebapp: true }];
        expect(selectWebapps(ports)).toHaveLength(1);
        expect(selectWebapps(ports)[0].proto).toBe("tcp6");
    });
});
