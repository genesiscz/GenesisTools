import { afterEach, describe, expect, test } from "bun:test";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { env } from "@genesiscz/utils/env";
import { unzip } from "@genesiscz/utils/fs/unzip";
import { SafeJSON } from "@genesiscz/utils/json";
import { alignOffset, normalizeIdentifiers } from "./align.ts";
import { buildAtCommit, managedWorktree, releaseBuildWorktrees, removeBuildWorktree } from "./build.ts";
import { type PruneResult, SourcemapCache } from "./cache.ts";
import { calibrate, sampleLiterals } from "./calibrate.ts";
import { carryMap, type EqualRun, encodeMappings, equalRuns } from "./carry.ts";
import { DirectoryMapSource, debugIdOf, mapsInArtifactBundle, SentryArtifactSource } from "./debug-id.ts";
import {
    assetsFromManifest,
    assetUrl,
    deployedFromDir,
    isoOfHttpDate,
    snapshotDeployment,
    snapshotPath,
    sourceMappingUrlOf,
} from "./deployed.ts";
import { crawlAssets, referencesInHtml, referencesInScript, resolveReference } from "./discover.ts";
import { repoPathsFor, sourceTail } from "./find-commit.ts";
import { findCommitHints } from "./hints.ts";
import { buildEnvFrom, envFlags, inlinedEnvObjects } from "./inlined-env.ts";
import { parseHunks, translateThroughHunks } from "./line-translate.ts";
import { blankBuildComments, chunkKey, chunkSimilarity, pairFiles } from "./pair.ts";
import { pairFilesByContent } from "./pair-content.ts";
import { parseEnvPairs, parsePositionRef } from "./position.ts";
import { DebugIdResolver, DeferredResolvers, LocalBuildResolver, resolvePosition } from "./resolvers/index.ts";
import { neighborsAgree } from "./resolvers/local-build.ts";
import { literalTokenAt, offsetOf, snapToToken } from "./resolvers/shared.ts";
import type { SourceResolver } from "./resolvers/types.ts";
import { sentryFromMcpServer } from "./sentry-config.ts";
import {
    decodeMappings,
    lineColumnAt,
    offsetAt,
    type RawSourceMap,
    SourceMapError,
    SourceMapIndex,
} from "./source-map.ts";
import { rankCommitsByTokens, sourceFileTokens, survivorTokens } from "./token-rank.ts";

describe("deployed assets", () => {
    test("manifests of any shape list their JS and CSS", () => {
        const cra = { files: { "main.js": "/app/static/js/main.1a2b3c4d.js", "x.map": "/app/x.map" }, entrypoints: [] };
        const vite = { "src/main.tsx": { file: "assets/index-B3x9kQ1a.js", css: ["assets/index-Cc1d2e3f.css"] } };
        expect(assetsFromManifest(cra)).toEqual(["/app/static/js/main.1a2b3c4d.js"]);
        expect(assetsFromManifest(vite).sort()).toEqual(["assets/index-B3x9kQ1a.js", "assets/index-Cc1d2e3f.css"]);
    });

    test("asset URLs and snapshot paths are relative to the base path", () => {
        expect(assetUrl("https://host.example.com/app", "/app/static/js/1.js")).toBe(
            "https://host.example.com/app/static/js/1.js"
        );
        expect(assetUrl("https://host.example.com/app/", "assets/a.js")).toBe(
            "https://host.example.com/app/assets/a.js"
        );
        expect(snapshotPath("https://host.example.com/app/static/js/1.ab.js", "https://host.example.com/app/")).toBe(
            "static/js/1.ab.js"
        );
        expect(snapshotPath("https://cdn.example.com/x/1.js", "https://host.example.com/app/")).toBe("x/1.js");
    });

    test("sourceMappingURL takes the last comment", () => {
        expect(sourceMappingUrlOf("a()\n//# sourceMappingURL=old.map\nb()\n//# sourceMappingURL=main.js.map\n")).toBe(
            "main.js.map"
        );
        expect(sourceMappingUrlOf("a()")).toBeNull();
    });
});

describe("pairing and similarity", () => {
    test("chunkKey drops the content hash", () => {
        expect(chunkKey("static/js/710.f9e49e56.chunk.js")).toBe("static/js/710.chunk.js");
        expect(chunkKey("static/js/main.e5716686.js")).toBe("static/js/main.js");
        expect(chunkKey("assets/index-B3x9kQ1a.js")).toBe("assets/index.js");
        expect(chunkKey("remoteEntry.js")).toBe("remoteEntry.js");
    });

    test("pairFiles matches by key and reports both leftovers", () => {
        const pairing = pairFiles(
            ["static/js/1.aaaaaaa1.chunk.js", "static/js/2.bbbbbbb2.chunk.js"],
            ["static/js/1.ccccccc3.chunk.js", "static/js/3.ddddddd4.chunk.js"]
        );
        expect(pairing.pairs).toEqual([
            {
                key: "static/js/1.chunk.js",
                deployed: "static/js/1.aaaaaaa1.chunk.js",
                local: "static/js/1.ccccccc3.chunk.js",
            },
        ]);
        expect(pairing.deployedOnly).toEqual(["static/js/2.bbbbbbb2.chunk.js"]);
        expect(pairing.localOnly).toEqual(["static/js/3.ddddddd4.chunk.js"]);
    });

    test("blanking keeps offsets, and renamed identifiers still count as the same code", () => {
        const code = "x()\n//# sourceMappingURL=1.abcdef12.chunk.js.map";
        expect(blankBuildComments(code)).toHaveLength(code.length);
        const body = (a: string) => `function ${a}(${a}1){return ${a}1*2+"some literal text here"}`.repeat(6);
        expect(chunkSimilarity(body("e"), body("t"), { probe: 32, step: 16 }).rate).toBe(1);
        const changed = chunkSimilarity(`${body("e")};q=[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18];`, body("t"), {
            probe: 32,
            step: 16,
        });
        expect(changed.rate).toBeLessThan(1);
        expect(changed.missedAt.length).toBeGreaterThan(0);
    });
});

describe("find-commit path tracing", () => {
    test("map sources resolve to tracked repo paths, preferring the build's project folder", () => {
        expect(sourceTail("webpack:///../packages/core/src/a.ts")).toBe("packages/core/src/a.ts");
        expect(sourceTail("webpack:///./src/App.tsx?abc")).toBe("src/App.tsx");
        expect(sourceTail("webpack://my-app/./src/./App.tsx")).toBe("src/App.tsx");
        expect(sourceTail("webpack://my-app/../packages/core/src/a.ts")).toBe("packages/core/src/a.ts");
        expect(sourceTail("webpack://my-app/src/App.tsx")).toBe("my-app/src/App.tsx");
        const tracked = ["web/src/App.tsx", "admin/src/App.tsx", "packages/core/src/a.ts"];
        expect(repoPathsFor({ source: "webpack:///./src/App.tsx", tracked, preferDir: "web" })).toEqual([
            "web/src/App.tsx",
        ]);
        expect(repoPathsFor({ source: "webpack:///./src/App.tsx", tracked })).toEqual([
            "web/src/App.tsx",
            "admin/src/App.tsx",
        ]);
        expect(repoPathsFor({ source: "webpack:///../packages/core/src/a.ts", tracked, preferDir: "web" })).toEqual([
            "packages/core/src/a.ts",
        ]);
    });
});

describe("token snap", () => {
    test("literal tokens are string literals and property names, never mangled names", () => {
        const code = 'a.b="INVALIDATE_FORM_ERROR";e.billingSettlementRestriction&&t(n)';
        expect(literalTokenAt(code, code.indexOf('"'))).toBe("INVALIDATE_FORM_ERROR");
        expect(literalTokenAt(code, code.indexOf("billing"))).toBe("billingSettlementRestriction");
        expect(literalTokenAt(code, code.indexOf("t(n)"))).toBeNull();
    });

    test("a coarse segment moves to the line that holds the token", () => {
        const map = SourceMapIndex.parse({
            version: 3,
            sources: ["src/errors.ts"],
            sourcesContent: [
                "export enum ErrorAction {\n  OPEN = 'OPEN_ERROR',\n  INVALIDATE = 'INVALIDATE_FORM_ERROR',\n}\n",
            ],
            mappings: "AAAA",
        });
        const position = { source: "src/errors.ts", line: 1, column: 0, name: null };
        expect(snapToToken({ map, position, token: "INVALIDATE_FORM_ERROR" })).toEqual({
            ...position,
            line: 3,
            column: 16,
        });
        expect(snapToToken({ map, position, token: "NOT_THERE_AT_ALL" })).toBeNull();
    });
});

describe("commit hints", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("only 40-hex strings that are commits of the repo count", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-hints-"));
        dirs.push(root);
        const git = (...args: string[]) =>
            Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", env: process.env })
                .stdout.toString()
                .trim();
        git("init", "-q");
        writeFileSync(join(root, "a.txt"), "a");
        git("add", "a.txt");
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "one");
        const head = git("rev-parse", "HEAD");
        mkdirSync(join(root, "deployed", "static"), { recursive: true });
        const fake = "0123456789abcdef0123456789abcdef01234567";
        writeFileSync(join(root, "deployed", "static", "main.js"), `x={sha:"${head}",k:"${fake}"};y="${head}"`);
        const hints = await findCommitHints({
            repo: root,
            deployed: {
                dir: join(root, "deployed"),
                files: [{ url: "https://host.example.com/static/main.js", path: "static/main.js", bytes: 0 }],
            },
        });
        expect(hints).toEqual([{ commit: head, occurrences: 2, files: ["static/main.js"] }]);
    });
});

describe("CLI arguments", () => {
    test("positions keep the URL's own colon", () => {
        expect(parsePositionRef("https://host.example.com/a.js:1234")).toEqual({
            url: "https://host.example.com/a.js",
            position: { offset: 1234 },
        });
        expect(parsePositionRef("https://host.example.com:8443/a.js:3:17")).toEqual({
            url: "https://host.example.com:8443/a.js",
            position: { line: 3, column: 17 },
        });
        expect(() => parsePositionRef("a.js:12")).toThrow("expected");
        expect(parseEnvPairs(["A=1", "B=x=y"])).toEqual({ A: "1", B: "x=y" });
        expect(() => parseEnvPairs(["nope"])).toThrow("KEY=VALUE");
    });
});

/** A git repo with one commit of `a.txt`; returns a runner for git in it that throws on failure. */
function fixtureRepo(dir: string): (...args: string[]) => string {
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]): string => {
        const result = Bun.spawnSync(["git", "-C", dir, ...args], { env: process.env });
        if (result.exitCode !== 0) {
            throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
        }

        return result.stdout.toString().trim();
    };
    git("init", "-q");
    writeFileSync(join(dir, "a.txt"), "a");
    git("add", "a.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "one");
    return git;
}

const prunedNames = (result: PruneResult): string[] => result.removed.map((item) => item.name);

describe("SourcemapCache", () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("commit indexes an entry, linkOut symlinks it, prune removes old entries and their links", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-cache-"));
        roots.push(root);
        const cache = new SourcemapCache("My App", root);
        expect(cache.dir).toBe(join(root, "my-app"));
        mkdirSync(cache.entryDir("old"), { recursive: true });
        writeFileSync(join(cache.entryDir("old"), "a.js"), "12345");
        await cache.commit({
            id: "old",
            kind: "deployed",
            label: "old",
            origin: { baseUrl: "https://host.example.com/" },
        });
        const link = await cache.linkOut("old", join(root, "out", "view"));
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect((await cache.get("old"))?.bytes).toBe(5);

        const metadata = await cache.read();
        const entry = metadata.entries.old;
        entry.lastUsedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
        writeFileSync(cache.metadataPath, SafeJSON.stringify(metadata));
        mkdirSync(cache.entryDir("new"), { recursive: true });
        await cache.commit({ id: "new", kind: "build", label: "new", origin: { commit: "abc" } });

        expect(Object.keys((await cache.read()).entries)).toEqual(["new"]);
        expect(existsSync(cache.entryDir("old"))).toBe(false);
        expect(existsSync(link)).toBe(false);
    });

    test("a link into an entry's subfolder shows that folder and goes when the entry is pruned", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-cache-"));
        roots.push(root);
        const cache = new SourcemapCache("app", root);
        mkdirSync(join(cache.entryDir("old"), "files"), { recursive: true });
        writeFileSync(join(cache.entryDir("old"), "files", "main.js"), "x");
        await cache.commit({ id: "old", kind: "build", label: "old", origin: {} });
        const link = await cache.linkOut("old", join(root, "out", "build"), "files");
        expect(readdirSync(link)).toEqual(["main.js"]);

        const metadata = await cache.read();
        metadata.entries.old.lastUsedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
        writeFileSync(cache.metadataPath, SafeJSON.stringify(metadata));
        expect(prunedNames(await cache.prune())).toEqual(["old"]);
        expect(existsSync(link)).toBe(false);
    });

    test("prune keeps a link into another entry whose name only starts like the expired one", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-cache-"));
        roots.push(root);
        const cache = new SourcemapCache("app", root);
        for (const id of ["build-1", "build-10"]) {
            mkdirSync(join(cache.entryDir(id), "files"), { recursive: true });
            await cache.commit({ id, kind: "build", label: id, origin: {} });
        }

        const link = await cache.linkOut("build-1", join(root, "out", "build"), "files");
        rmSync(link);
        symlinkSync(join(cache.entryDir("build-10"), "files"), link, "dir");
        const metadata = await cache.read();
        metadata.entries["build-1"].lastUsedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
        writeFileSync(cache.metadataPath, SafeJSON.stringify(metadata));
        expect(prunedNames(await cache.prune())).toEqual(["build-1"]);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });

    test("prune refuses an age that is not a number of days and removes nothing", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-cache-"));
        roots.push(root);
        const cache = new SourcemapCache("app", root);
        mkdirSync(cache.entryDir("kept"), { recursive: true });
        await cache.commit({ id: "kept", kind: "build", label: "kept", origin: {} });
        for (const maxAgeDays of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
            await expect(cache.prune({ maxAgeDays })).rejects.toThrow("maxAgeDays must be a number of days");
        }

        expect(Object.keys((await cache.read()).entries)).toEqual(["kept"]);
        expect(existsSync(cache.entryDir("kept"))).toBe(true);
        expect(prunedNames(await cache.prune({ maxAgeDays: 0 }))).toEqual(["kept"]);
    });

    test("concurrent commits never drop each other's entry", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-cache-"));
        roots.push(root);
        const cache = new SourcemapCache("app", root);
        const ids = Array.from({ length: 6 }, (_, i) => `build-${i}`);
        for (const id of ids) {
            mkdirSync(cache.entryDir(id), { recursive: true });
        }

        await Promise.all(ids.map((id) => cache.commit({ id, kind: "build", label: id, origin: {} })));
        expect(Object.keys((await cache.read()).entries).sort()).toEqual(ids);
    });

    test("prune keeps a link that was repointed away from the expired entry", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-cache-"));
        roots.push(root);
        const cache = new SourcemapCache("app", root);
        for (const id of ["old", "live"]) {
            mkdirSync(cache.entryDir(id), { recursive: true });
            await cache.commit({ id, kind: "build", label: id, origin: {} });
        }

        const viaCache = await cache.linkOut("old", join(root, "out", "via-cache"));
        const byHand = await cache.linkOut("old", join(root, "out", "by-hand"));
        await cache.linkOut("live", viaCache);
        rmSync(byHand);
        symlinkSync(cache.entryDir("live"), byHand, "dir");
        expect((await cache.get("old"))?.links).toEqual([byHand]);

        const metadata = await cache.read();
        metadata.entries.old.lastUsedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
        writeFileSync(cache.metadataPath, SafeJSON.stringify(metadata));
        expect(prunedNames(await cache.prune())).toEqual(["old"]);
        expect(lstatSync(viaCache).isSymbolicLink()).toBe(true);
        expect(lstatSync(byHand).isSymbolicLink()).toBe(true);
    });

    test("prune removes a failed build's folder and the build worktree once each is idle, not a build running now", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-cache-"));
        roots.push(root);
        const git = fixtureRepo(join(root, "repo"));
        const cache = new SourcemapCache("app", join(root, "cache"));
        for (const name of ["build-failed-1", "build-running-2"]) {
            mkdirSync(cache.entryDir(name), { recursive: true });
        }

        writeFileSync(join(cache.entryDir("build-failed-1"), ".build.log"), "12345");
        const worktree = managedWorktree(cache);
        git("worktree", "add", "-q", "--detach", worktree, "HEAD");
        const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
        utimesSync(cache.entryDir("build-failed-1"), twoHoursAgo, twoHoursAgo);

        // The worktree was used in the last hour, so a rebuild may still want its installed dependencies.
        expect(await cache.prune()).toEqual({
            removed: [{ name: "build-failed-1", reason: "unfinished", bytes: 5, diskBytes: 5 }],
            kept: [],
        });
        expect(existsSync(worktree)).toBe(true);

        utimesSync(worktree, twoHoursAgo, twoHoursAgo);
        const pruned = await cache.prune();
        expect(pruned.removed.map((item) => [item.name, item.reason])).toEqual([["worktree", "idle worktree"]]);
        expect(existsSync(worktree)).toBe(false);
        expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
        expect(existsSync(cache.entryDir("build-running-2"))).toBe(true);
    });

    test("prune keeps an idle build worktree that is locked, has tracked changes or has a process inside", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-cache-"));
        roots.push(root);
        const git = fixtureRepo(join(root, "repo"));
        const cache = new SourcemapCache("app", join(root, "cache"));
        const worktree = managedWorktree(cache);
        git("worktree", "add", "-q", "--detach", worktree, "HEAD");
        const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
        const pruneIdle = async () => {
            utimesSync(worktree, twoHoursAgo, twoHoursAgo);
            const result = await cache.prune();
            return [...prunedNames(result), ...result.kept.map((kept) => kept.outcome)];
        };

        git("worktree", "lock", "--reason", "agent session", worktree);
        expect((await cache.prune()).kept).toEqual([]);
        expect(await pruneIdle()).toEqual(["locked"]);
        git("worktree", "unlock", worktree);

        writeFileSync(join(worktree, "a.txt"), "edited");
        expect(await pruneIdle()).toEqual(["changed"]);
        writeFileSync(join(worktree, "a.txt"), "a");

        const inside = Bun.spawn(["sleep", "30"], { cwd: worktree, env: process.env });
        try {
            expect(await pruneIdle()).toEqual(["in-use"]);
        } finally {
            inside.kill();
            await inside.exited;
        }

        expect(existsSync(worktree)).toBe(true);
        // Nothing holds it any more: the same worktree goes.
        expect(await pruneIdle()).toEqual(["worktree"]);
        expect(existsSync(worktree)).toBe(false);
    });
});

describe("buildAtCommit", () => {
    const roots: string[] = [];
    afterEach(async () => {
        await releaseBuildWorktrees();
        for (const root of roots.splice(0)) {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("the command's release removes the managed worktree it built in, never a worktree the caller named", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-build-"));
        roots.push(root);
        const git = fixtureRepo(join(root, "repo"));
        const cache = new SourcemapCache("app", join(root, "cache"));
        // Untracked, not ignored: the install a real build leaves, which only `git worktree remove --force` takes.
        const buildCmd = "mkdir -p out node_modules/dep && echo dep > node_modules/dep/index.js && cp a.txt out/a.js";
        const build = (worktree?: string) =>
            buildAtCommit({
                cache,
                repo: join(root, "repo"),
                commit: "HEAD",
                buildCmd,
                outputDir: "out",
                worktree,
                refresh: worktree !== undefined,
            });
        await build();
        const named = join(root, "named");
        expect((await build(named)).reused).toBe(false);

        const released = await releaseBuildWorktrees();
        expect(released.map((removal) => [removal.worktree, removal.outcome])).toEqual([
            [managedWorktree(cache), "removed"],
        ]);
        expect(existsSync(managedWorktree(cache))).toBe(false);
        expect(existsSync(join(named, "node_modules", "dep", "index.js"))).toBe(true);
        expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(2);
        // The output stays in the cache.
        expect((await build()).reused).toBe(true);
        expect(await releaseBuildWorktrees()).toEqual([]);
    });

    test("a stopping release ends the running build, waits for it, then removes its worktree", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-build-"));
        roots.push(root);
        fixtureRepo(join(root, "repo"));
        const cache = new SourcemapCache("app", join(root, "cache"));
        const { promise: started, resolve: onStarted } = Promise.withResolvers<void>();
        const building = buildAtCommit({
            cache,
            repo: join(root, "repo"),
            commit: "HEAD",
            buildCmd: "echo started && exec sleep 30",
            outputDir: "out",
            onLine: (line) => {
                if (line === "started") {
                    onStarted();
                }
            },
        });
        const failed = building.then(
            () => null,
            (error: unknown) => error
        );
        await started;
        expect((await removeBuildWorktree({ cache, worktree: managedWorktree(cache) })).outcome).toBe("busy");

        const released = await releaseBuildWorktrees({ stop: true });
        expect(String(await failed)).toContain("build command exited");
        expect(released.map((removal) => removal.outcome)).toEqual(["removed"]);
        expect(existsSync(managedWorktree(cache))).toBe(false);
    });

    test("a refresh replaces the cached output, and a different env is a different build", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-build-"));
        roots.push(root);
        const repo = join(root, "repo");
        mkdirSync(repo);
        const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { env: process.env });
        git("init", "-q");
        writeFileSync(join(repo, "a.txt"), "a");
        git("add", "a.txt");
        git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "one");
        const counter = join(root, "counter");
        writeFileSync(counter, "1");
        const cache = new SourcemapCache("app", join(root, "cache"));
        // Every run writes a differently named chunk, as a real build does when the code moved.
        const buildCmd = `rm -rf out && mkdir out && n=$(cat '${counter}') && echo "$MODE" > "out/chunk-$n.js" && echo $((n + 1)) > '${counter}'`;
        const build = (mode: string, refresh = false) =>
            buildAtCommit({ cache, repo, commit: "HEAD", buildCmd, outputDir: "out", env: { MODE: mode }, refresh });

        const first = await build("a");
        expect(readdirSync(join(first.dir, "files"))).toEqual(["chunk-1.js"]);
        const refreshed = await build("a", true);
        expect(refreshed.dir).toBe(first.dir);
        expect(readdirSync(join(refreshed.dir, "files"))).toEqual(["chunk-2.js"]);

        const otherEnv = await build("b");
        expect(otherEnv.reused).toBe(false);
        expect(otherEnv.dir).not.toBe(first.dir);
        expect((await build("a")).reused).toBe(true);
    });

    test("two builds in the same worktree at once each cache their own commit's output", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-build-"));
        roots.push(root);
        const repo = join(root, "repo");
        mkdirSync(repo);
        const git = (...args: string[]) =>
            Bun.spawnSync(["git", "-C", repo, ...args], { env: process.env })
                .stdout.toString()
                .trim();
        git("init", "-q");
        const commits: string[] = [];
        for (const content of ["first", "second"]) {
            writeFileSync(join(repo, "a.txt"), content);
            git("add", "a.txt");
            git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", content);
            commits.push(git("rev-parse", "HEAD"));
        }

        const cache = new SourcemapCache("app", join(root, "cache"));
        // The pause lets a second checkout land in the middle of the first build when nothing serializes them.
        const buildCmd = "rm -rf out && mkdir out && sleep 0.1 && cp a.txt out/a.js";
        const results = await Promise.all(
            commits.map((commit) => buildAtCommit({ cache, repo, commit, buildCmd, outputDir: "out" }))
        );
        expect(results.map((result) => readFileSync(join(result.dir, "files", "a.js"), "utf8"))).toEqual([
            "first",
            "second",
        ]);
    });
});

describe("decodeMappings", () => {
    test("decodes absolute columns and relative source positions across lines", () => {
        // line 1: col 0 -> src 0 1:0, col 4 -> src 0 1:2 name 0 ; line 2: col 2 -> src 0 2:0
        const lines = decodeMappings("AAAA,IAAEA;EACF");
        expect(Array.from(lines[0])).toEqual([0, 0, 0, 0, -1, 4, 0, 0, 2, 0]);
        expect(Array.from(lines[1])).toEqual([2, 0, 1, 0, -1]);
    });

    test("decodes multi-digit and negative values", () => {
        // 32 needs a continuation digit ("gC"); -1 is "D".
        const lines = decodeMappings("gCAAD");
        expect(Array.from(lines[0])).toEqual([32, 0, 0, -1, -1]);
    });

    test("rejects malformed input", () => {
        expect(() => decodeMappings("A!AA")).toThrow(SourceMapError);
        expect(() => decodeMappings("AA")).toThrow(SourceMapError);
    });
});

describe("SourceMapIndex", () => {
    const map = SourceMapIndex.parse({
        version: 3,
        sources: ["src/a.ts"],
        sourcesContent: ["const answer = 42;\nexport default answer;\n"],
        names: ["answer"],
        mappings: "AAAA,IAAEA;EACF",
    });

    test("maps a generated position to the closest segment at or before it", () => {
        expect(map.originalPositionFor({ line: 1, column: 6 })).toEqual({
            source: "src/a.ts",
            line: 1,
            column: 2,
            name: "answer",
        });
        expect(map.originalPositionFor({ line: 2, column: 1 })).toBeNull();
        expect(map.originalPositionFor({ line: 9, column: 0 })).toBeNull();
        expect(map.sourceContent("src/a.ts")).toStartWith("const answer");
    });

    test("sourceContent takes a source as originalPositionFor names it, sourceRoot included", () => {
        const rooted = SourceMapIndex.parse({
            version: 3,
            sourceRoot: "app",
            sources: ["src/a.ts"],
            sourcesContent: ["const a = 1;\n"],
            mappings: "AAAA",
        });
        const position = rooted.originalPositionFor({ line: 1, column: 0 });
        expect(position?.source).toBe("app/src/a.ts");
        expect(rooted.sourceContent(position?.source ?? "")).toBe("const a = 1;\n");
        expect(rooted.sourceContent("src/a.ts")).toBe("const a = 1;\n");
        expect(rooted.sourceContent("app/src/b.ts")).toBeNull();
    });

    test("a one-field segment ends the mapped region before it", () => {
        const gapped = SourceMapIndex.parse({ version: 3, sources: ["src/a.ts"], mappings: "AAAA,K" });
        expect(gapped.originalPositionFor({ line: 1, column: 4 })).toMatchObject({ source: "src/a.ts", line: 1 });
        expect(gapped.originalPositionFor({ line: 1, column: 5 })).toBeNull();
        expect(gapped.originalPositionFor({ line: 1, column: 6 })).toBeNull();
    });

    test("refuses index maps and non-maps", () => {
        expect(() => SourceMapIndex.parse({ version: 3, sections: [] })).toThrow("index source maps");
        expect(() => SourceMapIndex.parse({ version: 2, sources: [], mappings: "" })).toThrow("not a v3");
    });

    test("line/column and offsets round-trip", () => {
        const text = "ab\ncde\nf";
        expect(lineColumnAt(text, 4)).toEqual({ line: 2, column: 1 });
        expect(offsetAt(text, { line: 2, column: 1 })).toBe(4);
        expect(offsetAt(text, { line: 5, column: 0 })).toBe(-1);
    });
});

describe("alignOffset", () => {
    const body = (a: string, b: string) =>
        `push([[710],{10710(${a},${b},n){n.d(${b},{Client:()=>q.K});const ${a}x="http.request_content_length";return ${a}x.length+${b}.size}}]);`;
    const deployed = `try{!function(){var e="undefined"!=typeof window?window:{};e._sentryDebugIds={}}()}catch(e){}${body("t", "e")}`;
    const local = `"use strict";${body("e", "t")}`;

    test("carries an offset across renamed identifiers and an injected prefix", () => {
        const offset = deployed.indexOf("http.request");
        const result = alignOffset({ from: normalizeIdentifiers(deployed), to: normalizeIdentifiers(local), offset });
        expect(result.confidence).toBe("unique");
        expect(local.slice(result.offset, result.offset + 12)).toBe("http.request");
    });

    test("an offset inside the injected prefix has no counterpart", () => {
        const offset = deployed.indexOf("_sentryDebugIds");
        const result = alignOffset({ from: normalizeIdentifiers(deployed), to: normalizeIdentifiers(local), offset });
        expect(result.confidence).toBe("none");
        expect(result.offset).toBe(-1);
    });
});

describe("chunk names across bundlers", () => {
    test("webpack, rspack and Vite hashes are dropped; plain words are kept", () => {
        expect(chunkKey("static/js/710.f9e49e56.chunk.js")).toBe("static/js/710.chunk.js");
        expect(chunkKey("static/js/async/1234.abcd1234.js")).toBe("static/js/async/1234.js");
        expect(chunkKey("assets/index-B6xY_3zQ.js")).toBe("assets/index.js");
        expect(chunkKey("assets/vendor-react-Bq9x-T_a.js")).toBe("assets/vendor-react.js");
        expect(chunkKey("assets/page-overview.js")).toBe("assets/page-overview.js");
    });
});

describe("line translation", () => {
    test("insertions, deletions and replacements move later lines by git's own numbering", () => {
        const inserted = parseHunks("@@ -3,0 +4,2 @@\n+a\n+b\n");
        expect(translateThroughHunks(inserted, 3)).toEqual({ line: 3, changed: false });
        expect(translateThroughHunks(inserted, 4)).toEqual({ line: 6, changed: false });
        const deleted = parseHunks("@@ -2,2 +1,0 @@\n-a\n-b\n");
        expect(translateThroughHunks(deleted, 1)).toEqual({ line: 1, changed: false });
        expect(translateThroughHunks(deleted, 2)).toEqual({ line: 2, changed: true });
        expect(translateThroughHunks(deleted, 4)).toEqual({ line: 2, changed: false });
        const replaced = parseHunks("@@ -5 +5,3 @@\n-x\n+y\n+z\n+w\n");
        expect(translateThroughHunks(replaced, 5)).toEqual({ line: 5, changed: true });
        expect(translateThroughHunks(replaced, 9)).toEqual({ line: 11, changed: false });
    });
});

describe("survivor tokens", () => {
    test("strings and property names count; module specifiers, directives and mangled locals do not", () => {
        const bag = survivorTokens(
            `"use strict";import x from "./dep.js";const a=require("lib");a.someProp=\`hello there\`;const o={keyName:1,"two words":2,"plainKey":3};`
        );
        expect(bag.get("p:someProp")).toBe(1);
        expect(bag.get("s:hello there")).toBe(1);
        expect(bag.get("p:keyName")).toBe(1);
        expect(bag.get("s:two words")).toBe(1);
        expect(bag.get("p:plainKey")).toBe(1);
        expect(bag.has("s:./dep.js")).toBe(false);
        expect(bag.has("p:lib")).toBe(false);
        expect(bag.has("s:use strict")).toBe(false);
        expect(bag.has("p:a")).toBe(false);
    });

    test("TypeScript and JSX sources are counted the way a bundle emits them", () => {
        const bag = sourceFileTokens(
            `enum Kind { Open = "open-state" }\nexport const C = () => <div className="box">Hello there</div>;`,
            "C.tsx"
        );
        expect(bag.get("p:Open")).toBe(1);
        expect(bag.get("s:open-state")).toBe(1);
        expect(bag.get("p:className")).toBe(1);
        expect(bag.get("s:Hello there")).toBe(1);
    });
});

describe("commit ranking by tokens", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("one reference build ranks the commit whose strings the deployment carries first", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-rank-"));
        dirs.push(root);
        const run = (...args: string[]) =>
            Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", env: process.env })
                .stdout.toString()
                .trim();
        const commitFile = (text: string) => {
            writeFileSync(join(root, "web", "src", "msg.ts"), text);
            run("add", "web/src/msg.ts");
            run("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", text.slice(0, 20));
            return run("rev-parse", "HEAD");
        };
        run("init", "-q");
        mkdirSync(join(root, "web", "src"), { recursive: true });
        const first = commitFile(`export const m = { title: "First headline text" };\n`);
        const second = commitFile(`export const m = { title: "Second headline text" };\n`);
        const third = commitFile(`export const m = { title: "Second headline text", other: "Third extra label" };\n`);
        for (const [name, code] of [
            ["reference", `var a={title:"Second headline text",other:"Third extra label"};`],
            ["deployed", `var b={title:"Second headline text"};`],
        ]) {
            mkdirSync(join(root, name), { recursive: true });
            writeFileSync(join(root, name, "app.js"), code);
        }

        writeFileSync(
            join(root, "reference", "app.js.map"),
            SafeJSON.stringify({ version: 3, sources: ["webpack:///./src/msg.ts"], names: [], mappings: "AAAA" })
        );
        const ranked = await rankCommitsByTokens({
            repo: root,
            deployed: { dir: join(root, "deployed"), files: [{ url: "file:///app.js", path: "app.js", bytes: 0 }] },
            reference: { dir: join(root, "reference"), files: ["app.js"], commit: third },
            candidates: [third, second, first],
            preferDir: "web",
        });
        expect(ranked.bundledFiles).toBe(1);
        // first differs from the deployment by one string, third by a whole extra field
        expect(ranked.ranking.map((entry) => entry.commit)).toEqual([second, first, third]);
        expect(ranked.ranking[0].error).toBe(0);
    });
});

describe("neighbour agreement", () => {
    const body = (rename: (i: number) => string, tail = "") =>
        Array.from({ length: 80 }, (_, i) => `${rename(i)}.prop${i}="value number ${i}";`).join("") + tail;

    test("renamed identifiers still agree; changed code after the position does not", () => {
        const deployedRaw = body((i) => `a${i % 7}`);
        const deployed = { raw: deployedRaw, normalized: normalizeIdentifiers(deployedRaw) };
        const renamedRaw = body((i) => `q${i % 7}`);
        const renamed = { raw: renamedRaw, normalized: normalizeIdentifiers(renamedRaw) };
        const offset = deployedRaw.indexOf("value number 40");
        const aligned = alignOffset({ from: deployed.normalized, to: renamed.normalized, offset });
        expect(neighborsAgree({ deployed, local: renamed, offset, alignedOffset: aligned.offset }).agree).toBe(true);

        const changedRaw = renamedRaw.slice(0, renamedRaw.indexOf("value number 41")) + "different code ".repeat(80);
        const changed = { raw: changedRaw, normalized: normalizeIdentifiers(changedRaw) };
        const alignedChanged = alignOffset({ from: deployed.normalized, to: changed.normalized, offset });
        expect(neighborsAgree({ deployed, local: changed, offset, alignedOffset: alignedChanged.offset })).toEqual({
            agree: false,
            side: "after",
        });
    });
});

describe("deployment folder", () => {
    test("files get URLs under the base and their maps when one sits next to them", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-dir-"));
        try {
            mkdirSync(join(root, "assets"), { recursive: true });
            writeFileSync(join(root, "assets", "a.js"), "x();\n//# sourceMappingURL=a.js.map");
            writeFileSync(join(root, "assets", "a.js.map"), "{}");
            writeFileSync(join(root, "assets", "b.js"), "y();\n//# sourceMappingURL=b.js.map");
            writeFileSync(join(root, "assets", "c.js"), "z();");
            const deployed = await deployedFromDir(root, "https://app.example.com/web/");
            const byPath = new Map(deployed.files.map((file) => [file.path, file]));
            expect(byPath.get("assets/a.js")).toMatchObject({
                url: "https://app.example.com/web/assets/a.js",
                mapPath: "assets/a.js.map",
                mapStatus: "fetched",
            });
            expect(byPath.get("assets/b.js")?.mapStatus).toBe("missing");
            expect(byPath.get("assets/c.js")?.mapStatus).toBe("none-referenced");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

/** A minimal zip writer for fixtures: stored or deflated entries, no extras. */
function zipOf(entries: Record<string, string>, deflate: boolean): Uint8Array {
    const encoder = new TextEncoder();
    const locals: Uint8Array[] = [];
    const centrals: Uint8Array[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(entries)) {
        const raw = encoder.encode(text);
        const data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
        const nameBytes = encoder.encode(name);
        const local = new Uint8Array(30 + nameBytes.length + data.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(8, deflate ? 8 : 0, true);
        lv.setUint32(18, data.length, true);
        lv.setUint32(22, raw.length, true);
        lv.setUint16(26, nameBytes.length, true);
        local.set(nameBytes, 30);
        local.set(data, 30 + nameBytes.length);
        const central = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(10, deflate ? 8 : 0, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, raw.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint32(42, offset, true);
        central.set(nameBytes, 46);
        locals.push(local);
        centrals.push(central);
        offset += local.length;
    }

    const size = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, centrals.length, true);
    ev.setUint16(10, centrals.length, true);
    ev.setUint32(12, size, true);
    ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + size + 22);
    let at = 0;
    for (const part of [...locals, ...centrals, end]) {
        out.set(part, at);
        at += part.length;
    }

    return out;
}

const DEBUG_ID = "0f3a6c1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b";
const BUNDLE_MANIFEST = SafeJSON.stringify({
    files: {
        "_/_/main.js": {
            url: "~/main.js",
            type: "minified_source",
            headers: { "debug-id": DEBUG_ID, sourcemap: "main.js.map" },
        },
        "_/_/main.js.map": { url: "~/main.js.map", type: "source_map", headers: { "Debug-Id": DEBUG_ID } },
    },
});
const BUNDLE_MAP = SafeJSON.stringify({ version: 3, sources: ["src/app.ts"], names: [], mappings: "AAAA" });

describe("debug ids", () => {
    test("the ECMA-426 comment wins over Sentry's snippet; neither means none", () => {
        expect(debugIdOf(`var e="sentry-dbid-${DEBUG_ID.toUpperCase()}";`)).toBe(DEBUG_ID);
        expect(debugIdOf(`x();\n//# debugId=${DEBUG_ID}\n//# sourceMappingURL=a.js.map`)).toBe(DEBUG_ID);
        expect(debugIdOf("x();")).toBeNull();
    });

    test("unzip reads stored and deflated entries", () => {
        for (const deflate of [false, true]) {
            const files = unzip(zipOf({ "a.txt": "hello ".repeat(50), "dir/b.json": "{}" }, deflate));
            expect(new TextDecoder().decode(files.get("a.txt"))).toBe("hello ".repeat(50));
            expect(files.has("dir/b.json")).toBe(true);
        }
    });

    test("a Sentry artifact bundle yields its maps by debug id", () => {
        const maps = mapsInArtifactBundle(
            unzip(
                zipOf({ "manifest.json": BUNDLE_MANIFEST, "_/_/main.js": "x()", "_/_/main.js.map": BUNDLE_MAP }, true)
            )
        );
        expect(maps.get(DEBUG_ID)).toBe(BUNDLE_MAP);
    });

    test("a maps folder finds maps by file name, by debug_id in the JSON, and inside bundles", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-ids-"));
        try {
            const other = "11111111-2222-4333-8444-555555555555";
            const third = "66666666-7777-4888-9999-aaaaaaaaaaaa";
            writeFileSync(join(root, `${other}.map`), BUNDLE_MAP);
            writeFileSync(
                join(root, "named.js.map"),
                SafeJSON.stringify({ ...SafeJSON.parse(BUNDLE_MAP), debug_id: third })
            );
            writeFileSync(
                join(root, "bundle.zip"),
                zipOf({ "manifest.json": BUNDLE_MANIFEST, "_/_/main.js.map": BUNDLE_MAP }, false)
            );
            writeFileSync(join(root, "broken.js.map"), "not json");
            const source = new DirectoryMapSource(root);
            expect(await source.mapFor(other)).toBe(BUNDLE_MAP);
            expect(await source.mapFor(third)).toContain(third);
            expect(await source.mapFor(DEBUG_ID)).toBe(BUNDLE_MAP);
            expect(await source.mapFor("00000000-0000-4000-8000-000000000000")).toBeNull();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a source that returns an unusable map is skipped and its map is not kept", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-ids-"));
        try {
            writeFileSync(join(root, "main.js"), `x();\n//# debugId=${DEBUG_ID}\n`);
            const kept: string[] = [];
            const resolver = new DebugIdResolver(
                { dir: root, files: [{ url: "https://app.example.com/main.js", path: "main.js", bytes: 0 }] },
                [
                    { name: "kept", mapFor: async () => "{}" },
                    { name: "folder", mapFor: async () => BUNDLE_MAP },
                ],
                async (_id, _text, source) => {
                    kept.push(source);
                }
            );
            const attempt = await resolver.resolve({
                url: "https://app.example.com/main.js",
                position: { line: 1, column: 0 },
            });
            expect(attempt.result).toMatchObject({ source: "src/app.ts", line: 1 });
            expect(kept).toEqual(["folder"]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("Sentry: the lookup's internal download host is replaced by the host the caller reached", async () => {
        const requested: string[] = [];
        const bundle = zipOf({ "manifest.json": BUNDLE_MANIFEST, "_/_/main.js.map": BUNDLE_MAP }, true);
        const source = new SentryArtifactSource(
            { url: "https://sentry.example.com", org: "acme", project: "web", token: "test-token" },
            async (url, init) => {
                requested.push(url);
                expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token");
                if (url.includes("debug_id=")) {
                    return new Response(
                        SafeJSON.stringify([
                            {
                                id: "artifact_bundle/7",
                                type: "bundle",
                                url: "http://sentry/api/0/projects/acme/web/artifact-lookup/?download=artifact_bundle/7",
                            },
                        ])
                    );
                }

                return new Response(new Blob([bundle.slice()]));
            }
        );
        expect(await source.mapFor(DEBUG_ID)).toBe(BUNDLE_MAP);
        expect(requested[1]).toBe(
            "https://sentry.example.com/api/0/projects/acme/web/artifact-lookup/?download=artifact_bundle/7"
        );
    });

    test("Sentry: a refused download says what permission is missing", async () => {
        const source = new SentryArtifactSource(
            { url: "https://sentry.example.com", org: "acme", project: "web", token: "test-token" },
            async (url) =>
                url.includes("debug_id=")
                    ? new Response(
                          SafeJSON.stringify([
                              {
                                  id: "artifact_bundle/7",
                                  type: "bundle",
                                  url: "https://sentry.example.com/x?download=7",
                              },
                          ])
                      )
                    : new Response("forbidden", { status: 403 })
        );
        await expect(source.mapFor(DEBUG_ID)).rejects.toThrow(/debug-files role/);
    });
});

describe("asset discovery without a manifest", () => {
    test("an HTML page names its scripts, styles and preloads, and keeps inline runtime code", () => {
        const html = `<html><head><link rel="stylesheet" href="/app/static/css/main.1a2b3c4d.css"><link rel="modulepreload" href="/app/assets/vendor-AbC_12-x.js"><link rel="icon" href="/app/favicon.ico"></head>
<body><script>window.cfg = 1;</script><script defer="defer" src="/app/static/js/main.0f1e2d3c.js"></script></body></html>`;
        const { refs, inlineScripts } = referencesInHtml(html);
        expect(refs).toEqual([
            "/app/static/js/main.0f1e2d3c.js",
            "/app/static/css/main.1a2b3c4d.css",
            "/app/assets/vendor-AbC_12-x.js",
        ]);
        expect(inlineScripts).toEqual(["window.cfg = 1;"]);
    });

    test("a webpack 5 / rspack runtime yields every chunk its name function can build", () => {
        const runtime = `r.u=e=>"static/js/"+({12:"vendors"}[e]||e)+"."+({12:"aaaaaaaa",34:"bbbbbbbb"})[e]+".chunk.js",r.miniCssF=e=>"static/css/"+e+".cccccccc.chunk.css";`;
        expect(referencesInScript(runtime).chunkNames.sort()).toEqual([
            "static/js/34.bbbbbbbb.chunk.js",
            "static/js/vendors.aaaaaaaa.chunk.js",
        ]);
    });

    test("a webpack 4 jsonpScriptSrc with the public path counts too", () => {
        const runtime = `function a(e){return n.p+"static/js/"+e+"."+{7:"dddddddd"}[e]+".chunk.js"}`;
        expect(referencesInScript(runtime).chunkNames).toEqual(["static/js/7.dddddddd.chunk.js"]);
    });

    test("an ES bundle yields its static and dynamic imports and its preload table", () => {
        const code = `import{a as b}from"./vendor-AbC_12-x.js";const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/Page-Zz9_aa-b.js","assets/Page-Zz9_aa-b.css"])))=>i.map(i=>d[i]);
export const load=()=>import("./Page-Zz9_aa-b.js");const w=new Worker(new URL("./worker-Qq1_bb-c.js",import.meta.url));const s="not/an/asset";`;
        expect(referencesInScript(code, "index.js").modules.sort()).toEqual([
            "./Page-Zz9_aa-b.js",
            "./vendor-AbC_12-x.js",
            "./worker-Qq1_bb-c.js",
            "assets/Page-Zz9_aa-b.css",
            "assets/Page-Zz9_aa-b.js",
        ]);
    });

    test("references resolve against the file for ./ and against the base otherwise, and never leave the base", () => {
        const base = "https://app.example.com/app/";
        const from = "https://app.example.com/app/assets/index-Ab12Cd34.js";
        expect(resolveReference("./x-Ab12Cd34.js", from, base)).toBe(
            "https://app.example.com/app/assets/x-Ab12Cd34.js"
        );
        expect(resolveReference("static/js/1.aaaaaaaa.chunk.js", from, base)).toBe(
            "https://app.example.com/app/static/js/1.aaaaaaaa.chunk.js"
        );
        expect(resolveReference("/other/x.js", from, base)).toBeNull();
        expect(resolveReference("https://cdn.example.net/x.js", from, base)).toBeNull();
    });

    test("crawl follows the page, the runtime table and imports, and drops what is not served", async () => {
        const site: Record<string, string> = {
            "https://app.example.com/app/": `<script src="/app/static/js/main.11111111.js"></script>`,
            "https://app.example.com/app/static/js/main.11111111.js": `r.u=e=>"static/js/"+e+"."+{5:"55555555",6:"66666666"}[e]+".chunk.js";`,
            "https://app.example.com/app/static/js/5.55555555.chunk.js": `import("./lazy-Ab12Cd34.js")`,
            "https://app.example.com/app/static/js/lazy-Ab12Cd34.js": "export default 1",
        };
        const crawled = await crawlAssets({
            baseUrl: "https://app.example.com/app/",
            fetcher: async (url) => (url in site ? new Response(site[url]) : new Response("missing", { status: 404 })),
        });
        expect(crawled.urls).toEqual([
            "https://app.example.com/app/static/js/5.55555555.chunk.js",
            "https://app.example.com/app/static/js/lazy-Ab12Cd34.js",
            "https://app.example.com/app/static/js/main.11111111.js",
        ]);
        expect(crawled.bodies.get("https://app.example.com/app/static/js/lazy-Ab12Cd34.js")).toBe("export default 1");
    });

    test("a relative page reference resolves against the page (and its <base href>), not the deployment base", async () => {
        const site: Record<string, string> = {
            "https://app.example.com/app/": `<script src="assets/main-Ab12Cd34.js"></script>`,
            "https://app.example.com/other/": `<base href="/app/v2/"><script src="entry-Cd34Ef56.js"></script>`,
            "https://app.example.com/app/assets/main-Ab12Cd34.js": "export default 1",
            "https://app.example.com/app/v2/entry-Cd34Ef56.js": "export default 2",
        };
        const crawled = await crawlAssets({
            baseUrl: "https://app.example.com/",
            pages: ["https://app.example.com/app/", "https://app.example.com/other/"],
            fetcher: async (url) => (url in site ? new Response(site[url]) : new Response("missing", { status: 404 })),
        });
        expect(crawled.urls).toEqual([
            "https://app.example.com/app/assets/main-Ab12Cd34.js",
            "https://app.example.com/app/v2/entry-Cd34Ef56.js",
        ]);
    });
});

describe("inlined env", () => {
    test("a process.env object and an import.meta.env object are read; computed values are skipped", () => {
        const code = `var a={NODE_ENV:"production",PUBLIC_URL:"/app",REACT_APP_FLAG:"true",REACT_APP_UNSET:void 0,REACT_APP_DYN:x()};
var b={BASE_URL:"/",MODE:"production",DEV:!1,PROD:!0,VITE_API:"https://api.example.com"};var c={NODE_ENV:"x"};`;
        expect(inlinedEnvObjects(code)).toEqual([
            { BASE_URL: "/", MODE: "production", DEV: "false", PROD: "true", VITE_API: "https://api.example.com" },
            { NODE_ENV: "production", PUBLIC_URL: "/app", REACT_APP_FLAG: "true", REACT_APP_UNSET: null },
        ]);
    });

    test("only values a caller sets go to the build, quoted for the shell", () => {
        const env = buildEnvFrom([
            { name: "NODE_ENV", value: "production", files: 2, conflicts: [] },
            { name: "REACT_APP_INFO", value: '{"version":"1.0 beta"}', files: 2, conflicts: [] },
            { name: "REACT_APP_UNSET", value: null, files: 2, conflicts: [] },
            { name: "PUBLIC_URL", value: "/app", files: 2, conflicts: [] },
        ]);
        expect(env).toEqual({ REACT_APP_INFO: '{"version":"1.0 beta"}', PUBLIC_URL: "/app" });
        expect(envFlags(env)).toEqual([`--env 'REACT_APP_INFO={"version":"1.0 beta"}'`, "--env PUBLIC_URL=/app"]);
    });

    test("an HTTP date becomes ISO; a missing or broken one is undefined", () => {
        expect(isoOfHttpDate("Wed, 07 Oct 2026 12:34:56 GMT")).toBe("2026-10-07T12:34:56.000Z");
        expect(isoOfHttpDate(null)).toBeUndefined();
        expect(isoOfHttpDate("yesterday")).toBeUndefined();
    });
});

describe("calibration by string literals", () => {
    test("only unique, distinctive literals are sampled, spread over the file", () => {
        const code = `a("Repeated literal x1");a("Repeated literal x1");b("Unique literal one");c("short");d("0123456789abcdef0123456789abcdef");e("Unique literal two")`;
        expect(sampleLiterals(code, 10).map((sample) => sample.literal)).toEqual([
            "Unique literal one",
            "Unique literal two",
        ]);
        expect(sampleLiterals(code, 1)).toHaveLength(1);
    });

    test("each answer is graded by whether the literal is in the source near it", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-calibrate-"));
        try {
            writeFileSync(
                join(root, "a.js"),
                `x("Found near the answer");y("Placed somewhere else");z("Nobody resolves this")`
            );
            const resolver: SourceResolver = {
                name: "fake",
                async resolve(request) {
                    const offset = (request.position as { offset: number }).offset;
                    if (offset > 50) {
                        return { resolver: "fake", result: null, reason: "no" };
                    }

                    const excerpt = offset < 20 ? ['>     4 | x("Found near the answer")'] : [">     9 | other()"];
                    return {
                        resolver: "fake",
                        result: {
                            source: "src/a.ts",
                            line: 4,
                            column: 0,
                            name: null,
                            resolver: "fake",
                            confidence: "aligned",
                            excerpt,
                            evidence: [],
                            warnings: [],
                        },
                    };
                },
            };
            const result = await calibrate({
                deployed: { dir: root, files: [{ url: "https://app.example.com/a.js", path: "a.js", bytes: 1 }] },
                resolvers: [resolver],
            });
            expect(result.samples).toBe(3);
            expect(result.unresolved).toBe(1);
            expect(result.byConfidence.aligned).toEqual({ samples: 2, near: 1, elsewhere: 1, unverifiable: 0 });
            expect(result.misses[0]?.literal).toBe("Placed somewhere else");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("carried maps", () => {
    test("mappings encode back to the same segments", () => {
        const lines = [
            [
                [0, 0, 0, 0, -1],
                [7, 0, 2, 4, 0],
                [12, 1, 10, 0, 1],
            ],
            [],
            [[3, -1, -1, -1, -1]],
        ];
        const decoded = decodeMappings(encodeMappings(lines)).map((line) => Array.from(line));
        expect(decoded).toEqual([[0, 0, 0, 0, -1, 7, 0, 2, 4, 0, 12, 1, 10, 0, 1], [], [3, -1, -1, -1, -1]]);
    });

    test("equal stretches skip a changed region and never cross", () => {
        const shared = "function alpha(){return 1};".repeat(3);
        const from = `${"A".repeat(40)}${shared}LOCAL-ONLY-CHANGE${"B".repeat(40)}`;
        const to = `${"A".repeat(40)}${shared}DEPLOYED-CHANGED-TEXT${"B".repeat(40)}`;
        const runs = equalRuns(from, to);
        expect(runs.length).toBeGreaterThan(0);
        for (let i = 1; i < runs.length; i++) {
            expect((runs[i] as EqualRun).from).toBeGreaterThanOrEqual(
                (runs[i - 1] as EqualRun).from + (runs[i - 1] as EqualRun).length
            );
            expect((runs[i] as EqualRun).to).toBeGreaterThanOrEqual(
                (runs[i - 1] as EqualRun).to + (runs[i - 1] as EqualRun).length
            );
        }

        for (const run of runs) {
            expect(from.slice(run.from, run.from + run.length)).toBe(to.slice(run.to, run.to + run.length));
        }
    });

    test("a local map moves to the deployed chunk across renamed identifiers and a prepended banner", () => {
        const body = (a: string, b: string) =>
            `function ${a}(${b}){var message="Something went wrong while loading";return ${b}+message.length}\nfunction second(${b}){return "another distinctive string literal here"+${b}}`;
        const localCode = body("n", "t");
        const deployedCode = `/* injected banner of the deployment, longer than an anchor */\n${body("e", "r")}`;
        const localMap: RawSourceMap = {
            version: 3,
            sources: ["src/app.ts"],
            names: [],
            // line 1 col 0 -> app.ts 10:0; line 2 col 0 -> app.ts 20:2
            mappings: encodeMappings([[[0, 0, 9, 0, -1]], [[0, 0, 19, 2, -1]]]),
        };
        const carried = carryMap({ deployedCode, localCode, localMap });
        expect(carried.carried).toBe(2);
        const index = SourceMapIndex.parse(carried.map);
        expect(index.originalPositionFor({ line: 2, column: 0 })).toMatchObject({ source: "src/app.ts", line: 10 });
        expect(index.originalPositionFor({ line: 3, column: 0 })).toMatchObject({ source: "src/app.ts", line: 20 });
    });

    test("code the deployed chunk inserted after an equal run maps to nothing, not to the run's last location", () => {
        // Words collapse when normalized, so the anchors here come from the digits and punctuation.
        const first = `function n(t){return [101,102,103,104,105,106,107,108,109,110].indexOf(t)};`;
        const second = `function second(t){return [201,202,203,204,205,206,207,208,209,210].indexOf(t)}`;
        const inserted = `[42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60];`;
        const localCode = `${first}${second}`;
        const deployedCode = `${first}${inserted}${second}`;
        const localMap: RawSourceMap = {
            version: 3,
            sources: ["src/app.ts"],
            names: [],
            mappings: encodeMappings([
                [
                    [0, 0, 9, 0, -1],
                    [first.length, 0, 19, 2, -1],
                ],
            ]),
        };
        const index = SourceMapIndex.parse(carryMap({ deployedCode, localCode, localMap }).map);
        expect(index.originalPositionFor({ line: 1, column: 5 })).toMatchObject({ line: 10 });
        expect(index.originalPositionFor({ line: 1, column: first.length + 20 })).toBeNull();
        expect(index.originalPositionFor({ line: 1, column: first.length + inserted.length })).toMatchObject({
            line: 20,
        });
    });
});

describe("offsetOf", () => {
    test("a position outside the file is -1: past the end, past its line, not a whole number", () => {
        const code = "ab\ncd";
        expect(offsetOf(code, { line: 2, column: 1 })).toBe(4);
        expect(offsetOf(code, { line: 1, column: 2 })).toBe(2);
        expect(offsetOf(code, { line: 1, column: 3 })).toBe(-1);
        expect(offsetOf(code, { line: 2, column: 2 })).toBe(-1);
        expect(offsetOf(code, { line: 3, column: 0 })).toBe(-1);
        expect(offsetOf(code, { line: 0, column: 0 })).toBe(-1);
        expect(offsetOf(code, { offset: 5 })).toBe(-1);
        expect(offsetOf(code, { offset: 1.5 })).toBe(-1);
        expect(offsetOf(code, { offset: 4 })).toBe(4);
    });
});

describe("local-build resolver", () => {
    test("a position past the end of the deployed file is unresolved, not aligned to its start", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-local-"));
        try {
            mkdirSync(join(root, "deployed"));
            mkdirSync(join(root, "build"));
            writeFileSync(join(root, "deployed", "main.0123abcd.js"), "x();\ny();\n");
            writeFileSync(join(root, "build", "main.89efcdab.js"), "x();\ny();\n");
            const resolver = new LocalBuildResolver(
                {
                    dir: join(root, "deployed"),
                    files: [{ url: "https://app.example.com/main.0123abcd.js", path: "main.0123abcd.js", bytes: 0 }],
                },
                { dir: join(root, "build"), files: ["main.89efcdab.js"], label: "build test" }
            );
            for (const position of [{ line: 99, column: 0 }, { offset: 500 }]) {
                const attempt = await resolver.resolve({ url: "https://app.example.com/main.0123abcd.js", position });
                expect(attempt.result).toBeNull();
                expect(attempt.reason).toContain("outside main.0123abcd.js");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("resolver chain", () => {
    const fake = (name: string, answers: boolean): SourceResolver => ({
        name,
        async resolve() {
            if (!answers) {
                return { resolver: name, result: null, reason: "no map" };
            }

            return {
                resolver: name,
                result: {
                    source: "src/a.ts",
                    line: 1,
                    column: 0,
                    name: null,
                    resolver: name,
                    confidence: "exact",
                    evidence: [],
                    warnings: [],
                },
            };
        },
    });
    const request = { url: "https://app.example.com/a.js", position: { offset: 1 } };

    test("deferred resolvers are made only when a position reaches them, and only once", async () => {
        let made = 0;
        const deferred = new DeferredResolvers("local builds", async () => {
            made++;
            return [fake("local", true)];
        });
        expect((await resolvePosition(request, [fake("exact", true), deferred])).result?.resolver).toBe("exact");
        expect(made).toBe(0);
        for (let i = 0; i < 2; i++) {
            expect((await resolvePosition(request, [fake("exact", false), deferred])).result?.resolver).toBe("local");
        }

        expect(made).toBe(1);
    });

    test("a deferred group that cannot be made is one failed attempt, not a thrown chain", async () => {
        const failing = new DeferredResolvers("local builds", async () => {
            throw new Error("build command exited 2");
        });
        const chain = await resolvePosition(request, [fake("exact", false), failing]);
        expect(chain.result).toBeNull();
        expect(chain.attempts.map((attempt) => [attempt.resolver, attempt.reason])).toEqual([
            ["exact", "no map"],
            ["local builds", "build command exited 2"],
        ]);
    });
});

describe("snapshotDeployment", () => {
    test("two URLs with one path (a query string, another origin) get two files, not one overwritten", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-snapshot-"));
        try {
            const base = "https://app.example.com/";
            const urls = [`${base}config.js?v=1`, `${base}config.js?v=2`, "https://cdn.example.net/config.js"];
            const snapshot = await snapshotDeployment({
                cache: new SourcemapCache("app", root),
                baseUrl: base,
                urls,
                bodies: new Map(urls.map((url, i) => [url, `window.v=${i}`])),
            });
            const paths = snapshot.files.map((file) => file.path);
            expect(paths[0]).toBe("config.js");
            expect(new Set(paths).size).toBe(3);
            expect(snapshot.files.map((file) => readFileSync(join(snapshot.dir, file.path), "utf8"))).toEqual([
                "window.v=0",
                "window.v=1",
                "window.v=2",
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("an asset the server says is gone is skipped, a failed fetch caches nothing", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-snapshot-"));
        const server = Bun.serve({
            port: 0,
            fetch(request) {
                const path = new URL(request.url).pathname;
                if (path === "/a.js") {
                    return new Response("console.log(1)");
                }

                return new Response("", { status: path === "/broken.js" ? 503 : 404 });
            },
        });
        try {
            const cache = new SourcemapCache("app", root);
            const base = `http://localhost:${server.port}/`;
            const kept = await snapshotDeployment({ cache, baseUrl: base, urls: [`${base}a.js`, `${base}gone.js`] });
            expect(kept.files.map((file) => file.path)).toEqual(["a.js"]);
            expect(await cache.get(kept.entry.id)).not.toBeNull();

            const urls = [`${base}a.js`, `${base}broken.js`];
            await expect(snapshotDeployment({ cache, baseUrl: base, urls })).rejects.toThrow(
                "1 of 2 assets could not be fetched"
            );
            expect(await cache.list()).toHaveLength(1);
        } finally {
            server.stop(true);
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("Sentry from an MCP server entry", () => {
    test("${VAR} and ${VAR:-fallback} expand; an unset reference is never sent as the token", async () => {
        await env.testing.withOverrides(
            { GT_TEST_SENTRY_TOKEN: "test-token", GT_TEST_SENTRY_HOST: undefined },
            async () => {
                const location = await sentryFromMcpServer({
                    args: [
                        "--access-token=${GT_TEST_SENTRY_TOKEN}",
                        "--host",
                        "${GT_TEST_SENTRY_HOST:-sentry.example.com}",
                    ],
                });
                expect(location).toMatchObject({ url: "https://sentry.example.com", token: "test-token" });
                await expect(
                    sentryFromMcpServer({ env: { SENTRY_ACCESS_TOKEN: "${GT_TEST_SENTRY_HOST}" } })
                ).rejects.toThrow("unset variables: GT_TEST_SENTRY_HOST");
                await expect(
                    sentryFromMcpServer({
                        args: ["--host", "${GT_TEST_SENTRY_HOST}", "--access-token=${GT_TEST_SENTRY_TOKEN}"],
                    })
                ).rejects.toThrow("empty Sentry host; it refers to unset variables: GT_TEST_SENTRY_HOST");
            }
        );
    });
});

describe("pairing by content", () => {
    test("hash-only chunk names are paired by shared tokens, best first; an unrelated chunk stays unpaired", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-pair-"));
        try {
            const cart = `export const a={label:"Add to cart",hint:"Your cart is empty",total:"Order total"};`;
            const login = `export const b={title:"Sign in to continue",error:"Wrong password",reset:"Forgot password"};`;
            const other = `export const c={x:"Completely different strings",y:"Nothing shared here at all"};`;
            mkdirSync(join(root, "deployed"));
            mkdirSync(join(root, "local"));
            writeFileSync(join(root, "deployed", "chunk-K3J2Q1ZA.js"), cart);
            writeFileSync(join(root, "deployed", "chunk-P4MJG2JU.js"), login);
            writeFileSync(join(root, "deployed", "main-SK5I2DK5.js"), "export const m=1;");
            writeFileSync(join(root, "local", "chunk-VIPG3EBN.js"), login.replace("b=", "q="));
            writeFileSync(join(root, "local", "chunk-C92K0RW1.js"), cart.replace("a=", "z="));
            writeFileSync(join(root, "local", "chunk-ABCD1234.js"), other);
            writeFileSync(join(root, "local", "main-XY12ZZ34.js"), "export const m=2;");
            const pairing = await pairFilesByContent({
                deployedDir: join(root, "deployed"),
                deployed: ["chunk-K3J2Q1ZA.js", "chunk-P4MJG2JU.js", "main-SK5I2DK5.js"],
                localDir: join(root, "local"),
                local: ["chunk-VIPG3EBN.js", "chunk-C92K0RW1.js", "chunk-ABCD1234.js", "main-XY12ZZ34.js"],
            });
            const byDeployed = Object.fromEntries(pairing.pairs.map((pair) => [pair.deployed, pair.local]));
            expect(byDeployed).toEqual({
                "main-SK5I2DK5.js": "main-XY12ZZ34.js",
                "chunk-K3J2Q1ZA.js": "chunk-C92K0RW1.js",
                "chunk-P4MJG2JU.js": "chunk-VIPG3EBN.js",
            });
            expect(pairing.byContent).toBe(2);
            expect(pairing.localOnly).toEqual(["chunk-ABCD1234.js"]);
            expect(new Set(pairing.pairs.map((pair) => pair.key)).size).toBe(3);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("check groups unresolved positions by the reason's shape and keeps one example", async () => {
        const root = mkdtempSync(join(tmpdir(), "gt-sourcemaps-reasons-"));
        try {
            writeFileSync(join(root, "a.js"), `x("First distinct literal");y("Second distinct literal")`);
            const resolver: SourceResolver = {
                name: "fake",
                async resolve(request) {
                    const offset = (request.position as { offset: number }).offset;
                    return { resolver: "fake", result: null, reason: `no window at ${offset} in chunk-AB12CD34.js` };
                },
            };
            const result = await calibrate({
                deployed: { dir: root, files: [{ url: "https://app.example.com/a.js", path: "a.js", bytes: 1 }] },
                resolvers: [resolver],
            });
            expect(result.unresolved).toBe(2);
            expect(result.reasons).toHaveLength(1);
            expect(result.reasons[0]?.count).toBe(2);
            expect(result.reasons[0]?.example).toMatch(/^fake: no window at \d+ in chunk-AB12CD34\.js$/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
