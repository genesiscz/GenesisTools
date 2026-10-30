import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
        expect(DASHBOARDS.jev.port).toBe(3088);
        expect(WEB_SERVICES["youtube-server"].port).toBe(9886);
        expect(WEB_SERVICES["youtube-extension"].port).toBe(9877);
        expect(WEB_SERVICES["ai-proxy"].port).toBe(8317);
        expect(WEB_SERVICES["mcp-gateway"].port).toBe(8318);
        expect(WEB_SERVICES["telegram-webhook"].port).toBe(8319);
        expect(WEB_SERVICES["mcp-oauth-callback"].port).toBe(8320);
        expect(registryEntryForPort(9886)?.name).toBe("YouTube Server");
    });

    test("telegram-webhook matches only the telegram-bot tool under the repo", () => {
        const entry = WEB_SERVICES["telegram-webhook"];

        expect(
            entry.matchProcess({
                port: 8319,
                command: "bun",
                fullCommand: "bun run /Users/x/GenesisTools/src/telegram-bot/index.ts start --webhook",
                cwd: "/Users/x/GenesisTools",
            })
        ).toBe(true);
        expect(
            entry.matchProcess({
                port: 8319,
                command: "node",
                fullCommand: "node /tmp/dev-server.js",
                cwd: "/tmp",
            })
        ).toBe(false);
    });

    test("every dashboard writes allowExecuteByPlainBrowserNavigationMightBeDangerous as its own literal true", () => {
        const flag = "allowExecuteByPlainBrowserNavigationMightBeDangerous";
        const ports = Object.values(DASHBOARDS).map((entry) => entry.port);

        expect(ports.toSorted((a, b) => a - b)).toEqual([
            3000, 3042, 3069, 3071, 3072, 3073, 3074, 3075, 3076, 3077, 3088, 3096, 7243, 7251,
        ]);

        for (const entry of Object.values(DASHBOARDS)) {
            expect({ key: entry.key, own: Object.hasOwn(entry, flag), value: entry[flag] }).toEqual({
                key: entry.key,
                own: true,
                value: true,
            });
        }

        // A web service never carries it: absent means a plain browser navigation must not start it.
        for (const entry of Object.values(WEB_SERVICES)) {
            expect({ key: entry.key, own: Object.hasOwn(entry, flag) }).toEqual({ key: entry.key, own: false });
        }
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
                cwd: "/Users/Martin/projects/GenesisTools",
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

    test("youtube-server rejects unrelated process on 9886", () => {
        const entry = WEB_SERVICES["youtube-server"];
        expect(
            entry.matchProcess({
                port: 9886,
                command: "node",
                fullCommand: "node /tmp/random-server.js",
                cwd: "/tmp",
            })
        ).toBe(false);

        expect(
            entry.matchProcess({
                port: 9886,
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

const UTILS_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(UTILS_ROOT, "../..");
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^"'`;]*?\sfrom\s*)?["']([^"']+)["']/g;

function resolveRelativeImport(from: string, specifier: string): string | null {
    const base = resolve(dirname(from), specifier);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
        }
    }

    return null;
}

/** Vite's config bundler inlines relative imports and externalizes bare ones, so only this closure matters. */
function bareUtilsImports(configFile: string): Map<string, string> {
    const seen = new Set<string>();
    const found = new Map<string, string>();
    const queue = [configFile];

    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
        if (seen.has(file)) {
            continue;
        }

        seen.add(file);
        for (const match of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
            const specifier = match[1];
            if (specifier.startsWith(".")) {
                const next = resolveRelativeImport(file, specifier);
                if (next) {
                    queue.push(next);
                }

                continue;
            }

            if (specifier === "@genesiscz/utils" || specifier.startsWith("@genesiscz/utils/")) {
                found.set(specifier, relative(REPO_ROOT, file));
            }
        }
    }

    return found;
}

function isExported(exportsMap: Record<string, unknown>, specifier: string): boolean {
    const subpath = specifier === "@genesiscz/utils" ? "." : `./${specifier.slice("@genesiscz/utils/".length)}`;
    if (subpath in exportsMap) {
        return true;
    }

    return Object.keys(exportsMap).some((key) => key.endsWith("*") && subpath.startsWith(key.slice(0, -1)));
}

describe("dashboard vite configs", () => {
    test("every bare @genesiscz/utils import a config bundles is in the package exports map", async () => {
        const pkg: { exports: Record<string, unknown> } = await Bun.file(join(UTILS_ROOT, "package.json")).json();
        const configs = Bun.spawnSync(["git", "ls-files", "--", "*vite.config.ts"], {
            cwd: REPO_ROOT,
            env: process.env,
        })
            .stdout.toString()
            .split("\n")
            .filter(Boolean);
        expect(configs.length).toBeGreaterThan(5);

        const missing: string[] = [];
        for (const config of configs) {
            for (const [specifier, importer] of bareUtilsImports(join(REPO_ROOT, config))) {
                if (!isExported(pkg.exports, specifier)) {
                    missing.push(`${config}: ${specifier} (imported by ${importer})`);
                }
            }
        }

        expect(missing).toEqual([]);
    });
});
