import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    configPathFor,
    linkIsSound,
    linkStatusFor,
    linkUtilsPackage,
    nearestConfigFor,
    PACKAGE_NAME,
    shadowedByFor,
    unlinkUtilsPackage,
    utilsPackageDir,
} from "./package-link";

/**
 * Every test works against a temp root. Nothing here may touch the real home directory: the
 * functions under test write and delete a `tsconfig.json`, and a default-argument slip would
 * do it in the developer's own `~`.
 */
const roots: string[] = [];

function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "gt-link-"));
    roots.push(dir);

    return dir;
}

function readConfigAt(root: string): Record<string, unknown> {
    return SafeJSON.parse(readFileSync(configPathFor(root), "utf8")) as Record<string, unknown>;
}

function mappingIn(root: string): string[] | undefined {
    const compilerOptions = readConfigAt(root).compilerOptions as { paths?: Record<string, string[]> } | undefined;

    return compilerOptions?.paths?.[`${PACKAGE_NAME}/*`];
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe("linkUtilsPackage", () => {
    test("writes the mapping and points it at this checkout", () => {
        const root = scratch();
        const result = linkUtilsPackage({ root });

        expect(result.outcome).toBe("created");
        expect(result.target).toBe(utilsPackageDir());
        expect(mappingIn(root)).toEqual([join(utilsPackageDir(), "*")]);
        expect(result.resolves).toBe(true);
    });

    test("maps the bare package as well as the wildcard, because both are real import shapes", () => {
        const root = scratch();
        linkUtilsPackage({ root });

        const compilerOptions = readConfigAt(root).compilerOptions as { paths: Record<string, string[]> };

        expect(compilerOptions.paths[PACKAGE_NAME]).toEqual([join(utilsPackageDir(), "index.ts")]);
    });

    test("🛑 a config it creates indexes no files, so an editor does not scan the whole root", () => {
        // Without these, a TypeScript server treats the root as a project and walks every file
        // beneath it. At the home directory that is the entire machine.
        const config = (() => {
            const root = scratch();
            linkUtilsPackage({ root });

            return readConfigAt(root);
        })();

        expect(config.files).toEqual([]);
        expect(config.include).toEqual([]);
    });

    test("is idempotent: a second run reports already, and changes nothing", () => {
        const root = scratch();
        const first = linkUtilsPackage({ root });
        const before = readFileSync(configPathFor(root), "utf8");
        const second = linkUtilsPackage({ root });

        expect(first.outcome).toBe("created");
        expect(second.outcome).toBe("already");
        expect(readFileSync(configPathFor(root), "utf8")).toBe(before);
    });

    test("merges into an existing config, keeping its other settings and its comments", () => {
        const root = scratch();
        writeFileSync(
            configPathFor(root),
            `{
    // the user's own note, which a parse/stringify round trip must not eat
    "compilerOptions": { "strict": true, "paths": { "@me/*": ["./src/*"] } },
    "include": ["src"]
}`
        );

        const result = linkUtilsPackage({ root });
        const raw = readFileSync(configPathFor(root), "utf8");
        const config = readConfigAt(root);
        const compilerOptions = config.compilerOptions as { strict: boolean; paths: Record<string, string[]> };

        expect(result.outcome).toBe("merged");
        expect(compilerOptions.strict).toBe(true);
        expect(compilerOptions.paths["@me/*"]).toEqual(["./src/*"]);
        expect(compilerOptions.paths[`${PACKAGE_NAME}/*`]).toEqual([join(utilsPackageDir(), "*")]);
        // 🛑 An existing project's own include is not ours to blank out.
        expect(config.include).toEqual(["src"]);
        expect(raw).toContain("the user's own note");
    });

    test("🛑 never overwrites a file that is not a JSON object", () => {
        const root = scratch();
        writeFileSync(configPathFor(root), "this is not json at all");

        const result = linkUtilsPackage({ root });

        expect(result.outcome).toBe("occupied");
        expect(readFileSync(configPathFor(root), "utf8")).toBe("this is not json at all");
    });

    test("🛑 never repoints a LIVE other checkout without force", () => {
        const root = scratch();
        const other = scratch();
        writeFileSync(
            configPathFor(root),
            SafeJSON.stringify({ compilerOptions: { paths: { [`${PACKAGE_NAME}/*`]: [join(other, "*")] } } })
        );

        const result = linkUtilsPackage({ root });

        expect(result.outcome).toBe("points-elsewhere");
        expect(result.existing).toBe(other);
        expect(mappingIn(root)).toEqual([join(other, "*")]);
    });

    test("force repoints a live mapping to this checkout", () => {
        const root = scratch();
        const other = scratch();
        writeFileSync(
            configPathFor(root),
            SafeJSON.stringify({ compilerOptions: { paths: { [`${PACKAGE_NAME}/*`]: [join(other, "*")] } } })
        );

        expect(linkUtilsPackage({ root, force: true }).outcome).toBe("merged");
        expect(mappingIn(root)).toEqual([join(utilsPackageDir(), "*")]);
    });

    test("repairs a STALE mapping without force, because nothing can depend on a missing path", () => {
        const root = scratch();
        const gone = join(tmpdir(), `gt-link-moved-${process.pid}-${Date.now()}`);
        writeFileSync(
            configPathFor(root),
            SafeJSON.stringify({ compilerOptions: { paths: { [`${PACKAGE_NAME}/*`]: [join(gone, "*")] } } })
        );

        expect(existsSync(gone)).toBe(false);

        const result = linkUtilsPackage({ root });

        expect(result.outcome).toBe("repaired");
        expect(mappingIn(root)).toEqual([join(utilsPackageDir(), "*")]);
    });
});

describe("linkStatusFor", () => {
    test("reports an absent mapping without creating one", () => {
        const root = scratch();
        const status = linkStatusFor(root);

        expect(status.pointsAt).toBeNull();
        expect(status.occupied).toBe(false);
        expect(status.current).toBe(false);
        expect(existsSync(configPathFor(root))).toBe(false);
    });

    test("reports a stale mapping as dangling, not as another checkout", () => {
        const root = scratch();
        writeFileSync(
            configPathFor(root),
            SafeJSON.stringify({
                compilerOptions: { paths: { [`${PACKAGE_NAME}/*`]: [join(tmpdir(), "gt-link-nowhere", "*")] } },
            })
        );

        const status = linkStatusFor(root);

        expect(status.dangling).toBe(true);
        expect(status.current).toBe(false);
    });

    test("reports an unparseable config as occupied", () => {
        const root = scratch();
        writeFileSync(configPathFor(root), "{ not json");

        expect(linkStatusFor(root).occupied).toBe(true);
    });

    test("🛑 reads a RELATIVE mapping as an absolute path", () => {
        // A `paths` target is normally written relative. Comparing the raw string against an
        // absolute path reported this repo's own tsconfig (`./src/utils`) as another checkout,
        // so `tools link status` called the running checkout foreign.
        const root = scratch();
        const nested = join(root, "src", "utils");
        mkdirSync(nested, { recursive: true });
        writeFileSync(
            configPathFor(root),
            SafeJSON.stringify({ compilerOptions: { paths: { [`${PACKAGE_NAME}/*`]: ["./src/utils/*"] } } })
        );

        expect(linkStatusFor(root).pointsAt).toBe(nested);
    });

    test("resolves a relative mapping against baseUrl when one is set", () => {
        const root = scratch();
        const nested = join(root, "packages", "utils");
        mkdirSync(nested, { recursive: true });
        writeFileSync(
            configPathFor(root),
            SafeJSON.stringify({
                compilerOptions: { baseUrl: "./packages", paths: { [`${PACKAGE_NAME}/*`]: ["./utils/*"] } },
            })
        );

        expect(linkStatusFor(root).pointsAt).toBe(nested);
    });

    test("reports a config with no mapping of ours as absent, not as another checkout", () => {
        const root = scratch();
        writeFileSync(configPathFor(root), SafeJSON.stringify({ compilerOptions: { strict: true } }));

        const status = linkStatusFor(root);

        expect(status.pointsAt).toBeNull();
        expect(status.occupied).toBe(false);
    });
});

describe("linkIsSound", () => {
    test("accepts the real package directory", () => {
        expect(linkIsSound(utilsPackageDir())).toBe(true);
    });

    test("rejects a directory with no manifest, or one naming a different package", () => {
        const root = scratch();

        expect(linkIsSound(root)).toBe(false);

        writeFileSync(join(root, "package.json"), '{ "name": "not-ours" }');
        expect(linkIsSound(root)).toBe(false);
    });

    test("rejects a path that does not exist", () => {
        expect(linkIsSound(join(tmpdir(), "gt-link-absent-dir"))).toBe(false);
    });
});

describe("unlinkUtilsPackage", () => {
    test("removes the config entirely when it held nothing else", () => {
        const root = scratch();
        linkUtilsPackage({ root });

        const result = unlinkUtilsPackage({ root });

        expect(result.outcome).toBe("removed");
        expect(result.configRemoved).toBe(true);
        expect(existsSync(configPathFor(root))).toBe(false);
    });

    test("🛑 keeps a config that has other settings, removing only our two keys", () => {
        const root = scratch();
        writeFileSync(
            configPathFor(root),
            SafeJSON.stringify({ compilerOptions: { strict: true, paths: { "@me/*": ["./src/*"] } } })
        );
        linkUtilsPackage({ root });

        const result = unlinkUtilsPackage({ root });
        const compilerOptions = readConfigAt(root).compilerOptions as {
            strict: boolean;
            paths: Record<string, string[]>;
        };

        expect(result.configRemoved).toBe(false);
        expect(existsSync(configPathFor(root))).toBe(true);
        expect(compilerOptions.strict).toBe(true);
        expect(compilerOptions.paths["@me/*"]).toEqual(["./src/*"]);
        expect(compilerOptions.paths[`${PACKAGE_NAME}/*`]).toBeUndefined();
    });

    test("says absent when there is nothing of ours to remove", () => {
        expect(unlinkUtilsPackage({ root: scratch() }).outcome).toBe("absent");
    });

    test("🛑 never removes another checkout's mapping without force", () => {
        const root = scratch();
        const other = scratch();
        writeFileSync(
            configPathFor(root),
            SafeJSON.stringify({ compilerOptions: { paths: { [`${PACKAGE_NAME}/*`]: [join(other, "*")] } } })
        );

        expect(unlinkUtilsPackage({ root }).outcome).toBe("points-elsewhere");
        expect(mappingIn(root)).toEqual([join(other, "*")]);

        expect(unlinkUtilsPackage({ root, force: true }).outcome).toBe("removed");
    });

    test("🛑 clears the earlier mechanism's node_modules husk, which disables Bun auto-install", () => {
        // An empty `node_modules` is not harmless leftover: Bun stops auto-installing packages
        // for every file beneath a directory that has one. Measured 2026-09-22 — picocolors
        // resolved from /tmp and failed from the home directory while the husk was there.
        const root = scratch();
        const scopeDir = join(root, "node_modules", "@genesiscz");
        mkdirSync(scopeDir, { recursive: true });
        symlinkSync(utilsPackageDir(), join(scopeDir, "utils"), "dir");

        const result = unlinkUtilsPackage({ root });

        expect(result.legacyRemoved).toBe(true);
        expect(existsSync(scopeDir)).toBe(false);
        expect(existsSync(join(root, "node_modules"))).toBe(false);
    });

    test("🛑 leaves a node_modules that holds anything else, husk pruning is not a sweep", () => {
        const root = scratch();
        const modulesDir = join(root, "node_modules");
        const scopeDir = join(modulesDir, "@genesiscz");
        mkdirSync(join(modulesDir, "someone-else"), { recursive: true });
        mkdirSync(scopeDir, { recursive: true });
        symlinkSync(utilsPackageDir(), join(scopeDir, "utils"), "dir");

        unlinkUtilsPackage({ root });

        expect(existsSync(scopeDir)).toBe(false);
        expect(existsSync(join(modulesDir, "someone-else"))).toBe(true);
    });
});

describe("resolution through an ancestor config", () => {
    test("a FRESH bun process resolves the bare specifier only once the mapping exists", async () => {
        // The claim this whole module makes is about a process it does not control. Asserting
        // it in-process would prove nothing: Bun caches resolution, and this test file already
        // resolves the package through the repo's own node_modules.
        const root = scratch();
        const deep = join(root, "a", "b");
        mkdirSync(deep, { recursive: true });

        const probe = join(deep, "probe.ts");
        writeFileSync(
            probe,
            'import { formatBytes } from "@genesiscz/utils/format";\nconsole.log(typeof formatBytes);\n'
        );

        const run = async (): Promise<number> => {
            // `env` is required: without it Bun does not forward the test temp root to the child.
            const proc = Bun.spawn(["bun", probe], {
                cwd: deep,
                env: process.env,
                stdout: "pipe",
                stderr: "pipe",
            });

            return await proc.exited;
        };

        expect(await run()).not.toBe(0);

        linkUtilsPackage({ root });

        expect(await run()).toBe(0);
    });
});

describe("shadowing", () => {
    // 🛑 Bun applies the paths of the NEAREST tsconfig only, never a merge up the chain. That
    // bound is what makes a home-directory mapping safe, and it is also the single way the
    // mapping fails. Measured 2026-09-22 on a real notes tree: six unrelated tsconfigs sat
    // under it, each hiding a home-directory mapping from every document beneath it.
    function nest(root: string, ...parts: string[]): string {
        const dir = join(root, ...parts);
        mkdirSync(dir, { recursive: true });

        return dir;
    }

    test("nearestConfigFor finds the closest config above a directory", () => {
        const root = scratch();
        const inner = nest(root, "project", "src");
        linkUtilsPackage({ root });
        writeFileSync(configPathFor(join(root, "project")), "{}");

        expect(nearestConfigFor(inner)).toBe(configPathFor(join(root, "project")));
    });

    test("names the nearer config that hides our mapping", () => {
        const root = scratch();
        const project = nest(root, "project");
        linkUtilsPackage({ root });
        writeFileSync(configPathFor(project), '{ "compilerOptions": { "strict": true } }');

        expect(shadowedByFor(project)).toBe(configPathFor(project));
    });

    test("is not a shadow when the nearer config carries the mapping itself", () => {
        const root = scratch();
        const project = nest(root, "project");
        linkUtilsPackage({ root });
        linkUtilsPackage({ root: project });

        expect(shadowedByFor(project)).toBeNull();
    });

    test("is not a shadow when no ancestor carries a mapping at all", () => {
        const root = scratch();
        const project = nest(root, "project");
        writeFileSync(configPathFor(project), "{}");

        // Nothing above it maps the package, so the nearer file hides nothing.
        expect(shadowedByFor(project)).toBeNull();
    });

    test("🛑 a nearer config really does break resolution, and installing into it fixes it", async () => {
        const root = scratch();
        const project = nest(root, "project", "src");
        const probe = join(project, "probe.ts");
        writeFileSync(
            probe,
            'import { formatBytes } from "@genesiscz/utils/format";\nconsole.log(typeof formatBytes);\n'
        );

        const run = async (): Promise<number> => {
            // `env` is required: without it Bun does not forward the test temp root.
            const proc = Bun.spawn(["bun", probe], {
                cwd: project,
                env: process.env,
                stdout: "pipe",
                stderr: "pipe",
            });

            return await proc.exited;
        };

        linkUtilsPackage({ root });
        expect(await run()).toBe(0);

        // A project with its own tsconfig hides the ancestor mapping completely.
        writeFileSync(configPathFor(join(root, "project")), '{ "compilerOptions": { "strict": true } }');
        expect(await run()).not.toBe(0);

        // Installing into that project merges the mapping in and restores it.
        linkUtilsPackage({ root: join(root, "project") });
        expect(await run()).toBe(0);
    });
});
