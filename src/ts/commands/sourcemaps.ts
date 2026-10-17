import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { pickEnumFlag } from "@genesiscz/utils/cli/enum-flag";
import { INTERRUPTED_EXIT_CODE, withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { formatBytes } from "@genesiscz/utils/format";
import { logger } from "@genesiscz/utils/logger";
import { completeCaChain } from "@genesiscz/utils/net/ca-chain";
import * as p from "@genesiscz/utils/prompts/p";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import {
    buildAtCommit,
    buildFilesDir,
    git,
    managedWorktree,
    releaseBuildWorktrees,
    type WorktreeRemoval,
} from "@genesiscz/utils/ts/sourcemaps/build";
import {
    cacheProjects,
    DEFAULT_MAX_AGE_DAYS,
    type PruneResult,
    projectSlug,
    SourcemapCache,
} from "@genesiscz/utils/ts/sourcemaps/cache";
import { calibrate } from "@genesiscz/utils/ts/sourcemaps/calibrate";
import { carryMaps } from "@genesiscz/utils/ts/sourcemaps/carry";
import {
    type DebugIdMapSource,
    DirectoryMapSource,
    SentryArtifactSource,
} from "@genesiscz/utils/ts/sourcemaps/debug-id";
import {
    type DeployedFile,
    type DeployedSnapshot,
    deployedFromDir,
    discoverAssets,
    listJsFiles,
    snapshotDeployment,
} from "@genesiscz/utils/ts/sourcemaps/deployed";
import {
    FIND_COMMIT_STRATEGIES,
    type FindCommitStrategy,
    findDeployedCommit,
} from "@genesiscz/utils/ts/sourcemaps/find-commit";
import { buildEnvFrom, envFlags, findInlinedEnv } from "@genesiscz/utils/ts/sourcemaps/inlined-env";
import { parseEnvPairs, parsePositionRef } from "@genesiscz/utils/ts/sourcemaps/position";
import { scoreBuild } from "@genesiscz/utils/ts/sourcemaps/rank";
import {
    type ChainResult,
    DebugIdResolver,
    DeferredResolvers,
    DeployedMapResolver,
    type LocalBuild,
    LocalBuildResolver,
    type ResolverChain,
    resolvePosition,
} from "@genesiscz/utils/ts/sourcemaps/resolvers/index";
import { displaySource } from "@genesiscz/utils/ts/sourcemaps/resolvers/shared";
import { claudeMcpServer, listSentryScopes, sentryFromMcpServer } from "@genesiscz/utils/ts/sourcemaps/sentry-config";
import type { Command } from "commander";
import pc from "picocolors";

const { out } = logger.scoped("ts:sourcemaps");
const CMD = toolCommand("ts sourcemaps");

interface CommonOpts {
    project?: string;
    json?: boolean;
}

interface DeployedOpts extends CommonOpts {
    deployed?: string;
    deployedDir?: string;
    asset?: string[];
    page?: string[];
    refresh?: boolean;
}

interface DebugIdOpts {
    mapsDir?: string;
    sentry?: string;
    sentryMcp?: string;
    sentryOrg?: string;
    sentryProject?: string;
    sentryTokenStdin?: boolean;
    sentryCa?: string;
}

interface BuildOpts extends CommonOpts {
    build?: string[];
    repo?: string;
    commit?: string;
    buildCmd?: string;
    output?: string;
    link?: string[];
    env?: string[];
    deployedEnv?: boolean;
    worktree?: string;
    keepWorktree?: boolean;
    buildCommit?: string;
    deployedCommit?: string;
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

function fail(message: string, hint?: string): never {
    out.log.error(message);
    if (hint) {
        out.log.info(`  ${hint}`);
    }

    process.exit(1);
}

function projectOf(opts: CommonOpts & { repo?: string; deployed?: string }): string {
    if (opts.project) {
        return projectSlug(opts.project);
    }

    if (opts.repo) {
        return projectSlug(basename(resolve(opts.repo)));
    }

    if (opts.deployed) {
        return projectSlug(new URL(opts.deployed).host);
    }

    return fail("--project is needed when neither --repo nor --deployed names the project");
}

async function snapshot(cache: SourcemapCache, opts: DeployedOpts): Promise<DeployedSnapshot> {
    if (!opts.deployed) {
        return fail("--deployed <base-url> is required", `e.g. ${CMD} fetch https://app.example.com/`);
    }

    const discovered = await discoverAssets(opts.deployed, undefined, { pages: opts.page, seeds: opts.asset });
    const urls = [...new Set([...discovered.urls, ...(opts.asset ?? [])])].sort();
    if (urls.length === 0) {
        fail(
            `found no assets under ${opts.deployed}: no build manifest (asset-manifest.json, .vite/manifest.json, manifest.json), and the page names no scripts under that base`,
            "pass the files with --asset <url> (repeatable), or the app's page with --page <url>"
        );
    }

    if (discovered.via === "crawl") {
        out.log.info(`no build manifest: found ${urls.length} files from the page's scripts and chunk references`);
    }

    for (const note of discovered.notes ?? []) {
        out.log.warn(note);
    }

    const spinner = out.spinner();
    spinner.start(`fetching ${urls.length} deployed assets and their published maps`);
    const result = await snapshotDeployment({
        cache,
        baseUrl: opts.deployed,
        urls,
        refresh: opts.refresh,
        bodies: discovered.bodies,
        lastModified: discovered.lastModified,
    });
    spinner.stop(`${result.reused ? "reused" : "fetched"} ${result.files.length} assets -> ${result.dir}`);
    return result;
}

/** The deployment to compare against: a folder on disk (--deployed-dir) or a fetched, cached snapshot. */
async function deployedSource(
    cache: SourcemapCache,
    opts: DeployedOpts
): Promise<{ dir: string; files: DeployedFile[] }> {
    if (opts.deployedDir) {
        return deployedFromDir(resolve(opts.deployedDir), opts.deployed);
    }

    return snapshot(cache, opts);
}

/**
 * The optional debug-id map sources: maps kept from earlier runs, a folder the caller filled, and Sentry's
 * artifact lookup (explicit flags, or a Sentry MCP server's own entry). Sentry is only asked when named.
 */
async function debugIdSources(
    cache: SourcemapCache,
    opts: DebugIdOpts
): Promise<{ sources: DebugIdMapSource[]; keep: (debugId: string, text: string) => Promise<void> }> {
    const kept = join(cache.dir, "debug-id-maps");
    const sources: DebugIdMapSource[] = [];
    if (existsSync(kept)) {
        sources.push(new DirectoryMapSource(kept));
    }

    if (opts.mapsDir) {
        sources.push(new DirectoryMapSource(resolve(opts.mapsDir)));
    }

    if (opts.sentry || opts.sentryMcp) {
        let base: { url: string; token: string; ca?: string | string[] };
        if (opts.sentryMcp) {
            const server = await claudeMcpServer(opts.sentryMcp, process.cwd());
            if (!server) {
                return fail(
                    `no MCP server named '${opts.sentryMcp}' in ~/.claude.json or a .mcp.json for ${process.cwd()}`
                );
            }

            base = await sentryFromMcpServer(server);
        } else {
            const token = opts.sentryTokenStdin ? (await Bun.stdin.text()).trim() : env.sentry.getAuthToken();
            if (!token) {
                return fail("--sentry needs a token: pipe it with --sentry-token-stdin, or set SENTRY_AUTH_TOKEN");
            }

            base = {
                url: opts.sentry ?? "",
                token,
                ca: opts.sentryCa ? await completeCaChain(await readFile(resolve(opts.sentryCa), "utf8")) : undefined,
            };
        }

        const org = opts.sentryOrg ?? env.sentry.getOrg();
        if (!org) {
            return fail(
                `--sentry-org is needed; this token sees: ${(await listSentryScopes(base)).join(", ") || "no organization"}`
            );
        }

        const project = opts.sentryProject ?? env.sentry.getProject();
        if (!project) {
            return fail(
                `--sentry-project is needed; ${org} has: ${(await listSentryScopes(base, org)).join(", ") || "no project"}`
            );
        }

        sources.push(new SentryArtifactSource({ ...base, org, project }));
    }

    const keep = async (debugId: string, text: string) => {
        await mkdir(kept, { recursive: true });
        await writeFile(join(kept, `${debugId}.map`), text);
    };
    return { sources, keep };
}

function withDebugIdFlags(cmd: Command): Command {
    return cmd
        .option(
            "--maps-dir <dir>",
            "maps fetched by any means, found by debug id (<id>.map, debug_id in the JSON, or Sentry bundle .zip)"
        )
        .option(
            "--sentry <url>",
            "ask Sentry's artifact lookup by debug id (optional; e.g. https://sentry.example.com)"
        )
        .option(
            "--sentry-mcp <server>",
            "take the Sentry URL, token and CA from this Claude Code MCP server entry (e.g. sentry-ocp)"
        )
        .option("--sentry-org <slug>", "Sentry organization (default: SENTRY_ORG); listed when missing")
        .option("--sentry-project <slug>", "Sentry project (default: SENTRY_PROJECT); listed when missing")
        .option("--sentry-token-stdin", "read the Sentry token from stdin (default: SENTRY_AUTH_TOKEN)")
        .option("--sentry-ca <pem>", "CA bundle for a Sentry behind a private CA");
}

/**
 * The resolvers `resolve` and `check` ask, in order: published maps, debug-id sources, then each local build.
 * The local builds are made only when a position gets past the exact resolvers, so a position a published or
 * debug-id map answers never waits on (or fails with) a build, and the TTY asks for local maps only then.
 */
async function resolverChain(
    cache: SourcemapCache,
    snap: { dir: string; files: DeployedFile[] },
    opts: DeployedOpts & BuildOpts & DebugIdOpts
): Promise<ResolverChain> {
    requireBuildFlags(opts);
    const resolvers: ResolverChain = [new DeployedMapResolver(snap)];
    const debugIds = await debugIdSources(cache, opts);
    if (debugIds.sources.length > 0) {
        resolvers.push(new DebugIdResolver(snap, debugIds.sources, debugIds.keep));
    }

    resolvers.push(
        new DeferredResolvers("local builds", async () => {
            const builds = await localBuilds(cache, opts, snap);
            const repo = opts.repo ? resolve(opts.repo) : undefined;
            const deployedCommit =
                repo && opts.deployedCommit ? await git(repo, ["rev-parse", opts.deployedCommit]) : undefined;
            return builds.map((build) => new LocalBuildResolver(snap, build, { repo, deployedCommit }));
        })
    );
    return resolvers;
}

/** `--build-cmd` needs the checkout, the commit and the output folder; checked before anything runs. */
function requireBuildFlags(opts: BuildOpts): void {
    if (opts.buildCmd && (!opts.repo || !opts.commit || !opts.output)) {
        fail(
            "--build-cmd needs --repo, --commit and --output",
            suggestCommand(CMD, {
                add: ["--repo", ".", "--commit", "<sha>", "--build-cmd", "'<cmd>'", "--output", "<dir>"],
            })
        );
    }
}

function subjectLine(repo: string, commit: string): Promise<string> {
    return git(resolve(repo), ["log", "-1", "--format=%s", commit]);
}

function mapStatusLine(snap: { files: DeployedFile[] }): string {
    const counts = new Map<string, number>();
    for (const file of snap.files) {
        if (file.mapStatus) {
            counts.set(file.mapStatus, (counts.get(file.mapStatus) ?? 0) + 1);
        }
    }

    return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(" · ");
}

/**
 * Wraps every action that can build, including interactive selection. Ctrl-C stops the build before cleanup.
 * `--keep-worktree` names the managed worktree explicitly, retaining its directory without bypassing cancellation.
 */
function releasesWorktree<A extends unknown[]>(action: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
    return async (...args: A) => {
        const ending = await withInterrupt(async (signal) => {
            const interrupted = new Promise<"interrupted">((resolve) => {
                signal.addEventListener("abort", () => resolve("interrupted"), { once: true });
            });
            try {
                return await Promise.race([action(...args).then(() => "done" as const), interrupted]);
            } finally {
                printReleased(await releaseBuildWorktrees({ stop: signal.aborted }));
            }
        });
        if (ending === "interrupted") {
            process.exit(INTERRUPTED_EXIT_CODE);
        }
    };
}

/** One line per build worktree a command released: what removing it freed, or why it stayed. */
function printReleased(removals: WorktreeRemoval[]): void {
    for (const removal of removals) {
        if (removal.outcome === "removed") {
            out.log.info(
                `removed the build worktree ${removal.worktree} (${sizeText(removal.bytes, removal.diskBytes ?? removal.bytes)}); --keep-worktree keeps it for a faster rebuild`
            );
        } else if (removal.outcome !== "absent") {
            const later =
                removal.outcome === "locked" || removal.outcome === "changed"
                    ? ""
                    : `; ${CMD} cache prune removes it once it is unused for an hour`;
            out.log.warn(`kept the build worktree ${removal.worktree}: ${removal.detail ?? removal.outcome}${later}`);
        }
    }
}

/** What removing something freed, with its size on disk when clones share part of it (`du` counts those blocks). */
function sizeText(bytes: number, diskBytes: number): string {
    return diskBytes > bytes
        ? `${formatBytes(bytes)} freed of ${formatBytes(diskBytes)} on disk; the rest is shared with clones, e.g. the package manager's cache`
        : `${formatBytes(bytes)} freed`;
}

/** `cache prune`: one project's cache, or every project's with --all; prints what it freed. */
async function pruneCaches(opts: {
    project?: string;
    all?: boolean;
    maxAgeDays: string;
    json?: boolean;
}): Promise<void> {
    const maxAgeDays = Number(opts.maxAgeDays);
    if (opts.maxAgeDays.trim() === "" || !Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
        fail(
            `--max-age-days takes a number of days, 0 or more; got '${opts.maxAgeDays}'`,
            `${CMD} cache prune --all --max-age-days ${DEFAULT_MAX_AGE_DAYS}`
        );
    }

    const projects = opts.all
        ? await cacheProjects()
        : opts.project
          ? [opts.project]
          : fail("cache prune needs --project <name> or --all", `${CMD} cache prune --all`);
    const results: (PruneResult & { project: string })[] = [];
    const failures: { project: string; error: string }[] = [];
    for (const project of projects) {
        try {
            const result = await new SourcemapCache(project).prune({ maxAgeDays });
            results.push({ project, ...result });
            for (const kept of result.kept) {
                if (kept.outcome === "failed") {
                    failures.push({ project, error: `${kept.worktree}: ${kept.detail ?? "worktree removal failed"}` });
                }
            }
        } catch (error) {
            logger.warn({ error, project }, "could not prune sourcemaps cache");
            failures.push({ project, error: error instanceof Error ? error.message : String(error) });
        }
    }

    if (failures.length > 0) {
        process.exitCode = 1;
    }

    const items = results.flatMap((result) => result.removed.map((item) => ({ project: result.project, ...item })));
    const freed = items.reduce((sum, item) => sum + item.bytes, 0);
    const onDisk = items.reduce((sum, item) => sum + item.diskBytes, 0);
    if (opts.json) {
        out.result({ projects: results, failures, freedBytes: freed, diskBytes: onDisk });
        return;
    }

    if (items.length > 0) {
        const table = createBoxTable(["PROJECT", "REMOVED", "WHY", "ON DISK", "FREED"]);
        for (const item of items) {
            table.push([item.project, item.name, item.reason, formatBytes(item.diskBytes), formatBytes(item.bytes)]);
        }

        out.println(table.toString());
    }

    out.println(
        items.length > 0
            ? `${sizeText(freed, onDisk)}: ${items.length} item(s) across ${projects.length} project(s)`
            : `nothing to prune in ${projects.length} project(s)`
    );
    for (const result of results) {
        for (const kept of result.kept) {
            out.println(pc.yellow(`⚠ ${result.project}: kept ${kept.worktree}: ${kept.detail ?? kept.outcome}`));
        }
    }
    for (const failure of failures) {
        out.log.error(`could not prune ${failure.project}: ${failure.error}`);
    }
}

/** D5: a finished folder, or the caller's own build command at a commit. Asks in a TTY when neither is given. */
async function localBuilds(
    cache: SourcemapCache,
    opts: BuildOpts,
    snap?: { dir: string; files: DeployedFile[] }
): Promise<LocalBuild[]> {
    if (!opts.build?.length && !opts.buildCmd && isInteractive()) {
        const choice = await p.select({
            message: "Where do the local source maps come from?",
            options: [
                { value: "folder", label: "a finished build folder (JS next to its .map files)" },
                { value: "command", label: "build a commit with my build command" },
                { value: "none", label: "none: only maps the deployment publishes" },
            ],
        });
        if (choice === "folder") {
            opts.build = [await p.text({ message: "Build output folder", placeholder: "web/build" })];
        } else if (choice === "command") {
            opts.repo ??= await p.text({ message: "Git checkout", initialValue: process.cwd() });
            opts.commit ??= await p.text({ message: "Commit (sha, tag or ref)", initialValue: "HEAD" });
            opts.buildCmd = await p.text({ message: "Build command, run in the worktree root" });
            opts.output ??= await p.text({ message: "Build output folder, relative to the worktree root" });
        }
    }

    const builds: LocalBuild[] = [];
    for (const dir of opts.build ?? []) {
        const absolute = resolve(dir);
        builds.push({
            dir: absolute,
            files: await listJsFiles(absolute),
            label: `build folder ${dir}`,
            commit:
                opts.buildCommit && opts.repo
                    ? await git(resolve(opts.repo), ["rev-parse", opts.buildCommit])
                    : undefined,
        });
    }

    if (opts.buildCmd) {
        requireBuildFlags(opts);
        if (!opts.repo || !opts.commit || !opts.output) {
            return builds;
        }

        const spinner = out.spinner();
        spinner.start(`building ${opts.commit} (${opts.buildCmd})`);
        const result = await buildAtCommit({
            cache,
            repo: resolve(opts.repo),
            commit: opts.commit,
            buildCmd: opts.buildCmd,
            outputDir: opts.output,
            links: opts.link,
            env: await buildEnv(opts, snap),
            worktree: opts.worktree ? resolve(opts.worktree) : opts.keepWorktree ? managedWorktree(cache) : undefined,
            onLine: (line) => spinner.message(line.slice(0, 100)),
        });
        spinner.stop(
            `${result.reused ? "reused cached build" : `built in ${Math.round(result.durationMs / 1000)} s`} ${result.commit.slice(0, 12)}`
        );
        const dir = buildFilesDir(cache, result.entry.id);
        builds.push({
            dir,
            files: await listJsFiles(dir),
            label: `build ${result.commit.slice(0, 12)}`,
            commit: result.commit,
        });
    }

    return builds;
}

/** --env pairs, plus with --deployed-env the env values the deployment inlined; an explicit --env wins. */
async function buildEnv(
    opts: BuildOpts,
    snap: { dir: string; files: DeployedFile[] } | undefined
): Promise<Record<string, string>> {
    const given = parseEnvPairs(opts.env ?? []);
    if (!opts.deployedEnv) {
        return given;
    }

    if (!snap) {
        fail("--deployed-env reads the deployment: pass --deployed <base-url> or --deployed-dir <dir>");
    }

    const inlined = buildEnvFrom(await findInlinedEnv(snap));
    const names = Object.keys(inlined);
    out.log.info(
        names.length > 0
            ? `--deployed-env: ${names.length} value(s) from the deployment: ${names.join(", ")}`
            : "--deployed-env: the deployment inlined no env object (nothing added)"
    );
    return { ...inlined, ...given };
}

function printChain(chain: ChainResult): void {
    const where =
        "offset" in chain.request.position
            ? `offset ${chain.request.position.offset}`
            : `${chain.request.position.line}:${chain.request.position.column}`;
    out.println(pc.bold(`${chain.request.url.replace(/^[a-z]+:\/\/[^/]+/i, "")} @ ${where}`));
    const result = chain.result;
    if (!result) {
        out.println(pc.red("  not resolved"));
        for (const attempt of chain.attempts) {
            out.println(pc.dim(`  ${attempt.resolver}: ${attempt.reason ?? "no answer"}`));
        }

        return;
    }

    const color = result.confidence === "exact" ? pc.green : result.confidence === "aligned" ? pc.cyan : pc.yellow;
    out.println(
        `  -> ${pc.white(`${displaySource(result.source)}:${result.line}:${result.column}`)}${result.name ? ` ${result.name}` : ""}  ${color(`[${result.confidence} via ${result.resolver}]`)}`
    );
    for (const line of result.evidence) {
        out.println(pc.dim(`     ${line}`));
    }

    for (const line of result.warnings) {
        out.println(pc.yellow(`     ⚠ ${line}`));
    }

    for (const line of result.excerpt ?? []) {
        out.println(line.startsWith(">") ? pc.white(`     ${line}`) : pc.dim(`     ${line}`));
    }
}

function withBuildFlags(cmd: Command): Command {
    return cmd
        .option("--build <dir>", "a finished build folder (JS next to its .map files); repeatable", collect)
        .option("--repo <dir>", "git checkout to build from (never built in place: a worktree is used)")
        .option("--commit <ref>", "commit to build with --build-cmd")
        .option("--build-cmd <cmd>", "YOUR build command, run with sh -c in the worktree root")
        .option("--output <dir>", "the build output folder, relative to the worktree root")
        .option(
            "--link <file>",
            "untracked file of --repo to symlink into the worktree (e.g. .npmrc); repeatable",
            collect
        )
        .option("--env <KEY=VALUE>", "extra environment for the build command; repeatable", collect)
        .option(
            "--deployed-env",
            "also pass the env values the deployment inlined (what `env` prints); an explicit --env wins"
        )
        .option("--worktree <dir>", "build in this worktree instead of the managed one under the cache (never removed)")
        .option(
            "--keep-worktree",
            "keep the managed build worktree and its installed dependencies for a faster next build (default: removed when the command ends; cache prune removes it after an hour unused)"
        )
        .option("--build-commit <ref>", "the commit a --build folder was made from (enables line translation)")
        .option(
            "--deployed-commit <ref>",
            "the commit the deployment was built from (find-commit's answer): lines are translated to it with git diff"
        );
}

function withDeployedFlags(cmd: Command): Command {
    return cmd
        .option(
            "--deployed <base-url>",
            "where the app is deployed; files come from its build manifest, else from its page and chunk references"
        )
        .option("--page <url>", "an app page to start from when the base URL serves no HTML (repeatable)", collect)
        .option(
            "--asset <url>",
            "a deployed file discovery misses (its chunk references are followed too); repeatable",
            collect
        )
        .option(
            "--deployed-dir <dir>",
            "a copy of the deployment on disk instead of fetching it (a downloaded artifact, or a local build standing in)"
        )
        .option("--refresh", "fetch again even when the cache has this deployment")
        .option("--project <name>", "cache folder name (default: the --repo folder name, else the host)")
        .option("--json", "machine-readable result");
}

export function registerSourcemapsCommands(program: Command): void {
    const group = program
        .command("sourcemaps")
        .description(
            "map positions in DEPLOYED minified JS back to source, even when the deployment publishes no maps"
        );

    withDebugIdFlags(withBuildFlags(withDeployedFlags(group.command("resolve"))))
        .description("resolve <url>:<offset> or <url>:<line>:<col> through: the published map, then a local build")
        .argument(
            "<positions...>",
            "deployed positions, e.g. https://app.example.com/static/js/710.f9e49e56.chunk.js:12345"
        )
        .addHelpText(
            "after",
            `
Resolvers, in order: the deployment's own .map (exact), then each local build (the position is carried
over by a code window with identifiers collapsed, so different mangling and injected banners do not matter).
A local build of another commit still resolves unchanged modules; the result says how much of the chunk differs.
Pass --deployed-commit (find-commit's answer) when the build is another commit: lines are moved to the
deployed commit's version of the file with git diff. Exit code 1 when any position stays unresolved.

Examples:
  ${CMD} resolve https://app.example.com/static/js/710.f9e49e56.chunk.js:95812 --deployed https://app.example.com/ --build ./web/build
  ${CMD} resolve <url>:<offset> --deployed <base> --repo . --commit v1.2.3 --build-cmd 'bun install && bun run build' --output web/build`
        )
        .action(
            releasesWorktree(async (positions: string[], opts: DeployedOpts & BuildOpts & DebugIdOpts) => {
                const requests = positions.map((ref) => {
                    try {
                        return parsePositionRef(ref);
                    } catch (error) {
                        return fail(error instanceof Error ? error.message : String(error));
                    }
                });
                // A --deployed-dir snapshot still answers https:// positions: its files get URLs under this origin.
                if (/^https?:/.test(requests[0].url)) {
                    opts.deployed ??= new URL(requests[0].url).origin;
                }

                const cache = new SourcemapCache(projectOf(opts));
                const snap = await deployedSource(cache, opts);
                const resolvers = await resolverChain(cache, snap, opts);
                const results: ChainResult[] = [];
                for (const request of requests) {
                    results.push(await resolvePosition(request, resolvers));
                }

                // A script that resolves a position must be able to tell "not found" from an answer by the exit code.
                if (results.some((chain) => !chain.result)) {
                    process.exitCode = 1;
                }

                if (opts.json) {
                    out.result(results);
                    return;
                }

                out.println(pc.dim(`published maps: ${mapStatusLine(snap)}`));
                for (const chain of results) {
                    printChain(chain);
                }
            })
        );

    withDeployedFlags(group.command("fetch"))
        .description("snapshot a deployment's JS/CSS into the cache and preflight every file's published .map")
        .argument("[base-url]", "deployed base URL (same as --deployed)")
        .option("--out <dir>", "also expose the snapshot here (a symlink into the cache)")
        .action(async (baseUrl: string | undefined, opts: DeployedOpts & { out?: string }) => {
            opts.deployed ??= baseUrl;
            const cache = new SourcemapCache(projectOf(opts));
            const snap = await snapshot(cache, opts);
            const link = opts.out ? await cache.linkOut(snap.entry.id, opts.out) : null;
            if (opts.json) {
                out.result({ entry: snap.entry, dir: snap.dir, link, files: snap.files });
                return;
            }

            out.println(`published maps: ${mapStatusLine(snap)}`);
            out.println(`cache: ${snap.dir}${link ? `\nlink:  ${link}` : ""}`);
        });

    withDebugIdFlags(withBuildFlags(withDeployedFlags(group.command("check"))))
        .description("measure how often resolve is right on THIS deployment, using string literals as ground truth")
        .option("--per-file <n>", "literals sampled per deployed file", "8")
        .option("--files <n>", "deployed files sampled, spread evenly (default: all)")
        .addHelpText(
            "after",
            `
No map gives the truth for a deployment without maps, but its string literals do: they survive minification
as they are. check samples unique literals, resolves each one's position with the same chain resolve uses,
and counts how often the literal is in the source within 3 lines of the answer, per confidence word
(exact / aligned / approximate). Run it once per deployment and build pair, then trust resolve's words as
far as these numbers say. Literal-heavy code is easier than average: read it as an upper bound.

Example:
  ${CMD} check --deployed https://app.example.com/ --build ./web/build --files 40`
        )
        .action(
            releasesWorktree(
                async (opts: DeployedOpts & BuildOpts & DebugIdOpts & { perFile: string; files?: string }) => {
                    const cache = new SourcemapCache(projectOf(opts));
                    const snap = await deployedSource(cache, opts);
                    const resolvers = await resolverChain(cache, snap, opts);
                    const result = await calibrate({
                        deployed: snap,
                        resolvers,
                        perFile: Number(opts.perFile),
                        maxFiles: opts.files ? Number(opts.files) : undefined,
                    });
                    if (opts.json) {
                        out.result(result);
                        return;
                    }

                    const pct = (part: number, whole: number) =>
                        whole === 0 ? "—" : `${((100 * part) / whole).toFixed(1)}%`;
                    const table = createBoxTable([
                        "CONFIDENCE",
                        "SAMPLES",
                        "NEAR (±3 LINES)",
                        "ELSEWHERE",
                        "NO SOURCE TEXT",
                    ]);
                    for (const [confidence, tier] of Object.entries(result.byConfidence)) {
                        table.push([
                            confidence,
                            String(tier.samples),
                            pct(tier.near, tier.samples - tier.unverifiable),
                            String(tier.elsewhere),
                            String(tier.unverifiable),
                        ]);
                    }

                    out.println(table.toString());
                    out.println(
                        `${result.samples} literals in ${result.files} files, ${result.unresolved} unresolved (${pct(result.unresolved, result.samples)}), ${(result.ms / 1000).toFixed(1)} s`
                    );
                    for (const reason of result.reasons.slice(0, 3)) {
                        out.println(
                            pc.yellow(`  unresolved ${reason.count}x: ${truncateDisplay(reason.example, 160)}`)
                        );
                    }

                    for (const miss of result.misses.slice(0, 5)) {
                        out.println(
                            pc.dim(
                                `  miss: "${truncateDisplay(miss.literal, 40)}" -> ${miss.answer} (${miss.confidence})`
                            )
                        );
                    }
                }
            )
        );

    withBuildFlags(withDeployedFlags(group.command("carry")))
        .description("write a source map for every deployed chunk, carried over from a local build, for DevTools")
        .requiredOption("--out <dir>", "folder for the carried maps and their index.json")
        .addHelpText(
            "after",
            `
Each deployed chunk is compared with its local counterpart with identifiers collapsed, and every local
mapping in code that is equal is moved to the same code in the deployed chunk; mappings in code that
differs are dropped, never guessed. The maps name the LOCAL build's lines, so build the deployed commit
(find-commit) for line-exact results. Measured: webpack and rsbuild 100% right line on 12k+ probes in
about 1.4 s for 350 chunks; Vite with a build 3 commits off 90%.

Then let DevTools show the real sources while you debug the deployed page:
  ${toolCommand("chrome-devtools", "intercept", "--match", "<tab>", "--map-dir", "<out>")}

Example:
  ${CMD} carry --deployed https://app.example.com/ --build ./web/build --out ./carried-maps`
        )
        .action(
            releasesWorktree(async (opts: DeployedOpts & BuildOpts & { out: string }) => {
                const cache = new SourcemapCache(projectOf(opts));
                const snap = await deployedSource(cache, opts);
                const builds = await localBuilds(cache, opts, snap);
                const build = builds[0];
                if (!build) {
                    return fail("carry needs a local build: --build <dir>, or --repo/--commit/--build-cmd/--output");
                }

                const outDir = resolve(opts.out);
                await mkdir(outDir, { recursive: true });
                const result = await carryMaps({ deployed: snap, build, outDir });
                if (opts.json) {
                    out.result({ outDir, ...result });
                    return;
                }

                const segments = result.files.reduce((sum, file) => sum + file.segments, 0);
                const carried = result.files.reduce((sum, file) => sum + file.carried, 0);
                out.println(
                    `${result.files.length} maps written to ${outDir} (${((100 * carried) / Math.max(1, segments)).toFixed(1)}% of mappings carried), ${result.skipped.length} deployed file(s) without a local counterpart, ${(result.ms / 1000).toFixed(1)} s`
                );
                for (const file of result.files.filter((entry) => entry.carried < entry.segments * 0.9).slice(0, 8)) {
                    out.println(
                        pc.yellow(
                            `  ⚠ ${file.path}: only ${((100 * file.carried) / file.segments).toFixed(0)}% carried (the chunk differs from the build)`
                        )
                    );
                }

                out.println(
                    pc.dim(
                        `DevTools: ${toolCommand("chrome-devtools", "intercept", "--match", "<tab>", "--map-dir", outDir)}`
                    )
                );
            })
        );

    withDeployedFlags(group.command("env"))
        .description(
            "the env values a deployment inlined (process.env / import.meta.env objects), as --env flags for a build"
        )
        .argument("[base-url]", "deployed base URL (same as --deployed)")
        .addHelpText(
            "after",
            `
A local build made with other env values differs from the deployment in strings and, worse, in the code a
bundler removed as dead (if (process.env.REACT_APP_X === "true") ...). Pass these to build / find-commit.
Only env OBJECTS are recoverable: a value a define replaced one by one has lost its name.`
        )
        .action(async (baseUrl: string | undefined, opts: DeployedOpts) => {
            opts.deployed ??= baseUrl;
            const deployed = await deployedSource(new SourcemapCache(projectOf(opts)), opts);
            const values = await findInlinedEnv(deployed);
            const flags = envFlags(buildEnvFrom(values));
            if (opts.json) {
                out.result({ values, flags });
                return;
            }

            if (values.length === 0) {
                out.log.info("no inlined env object found (the bundler may replace values one by one)");
                return;
            }

            const table = createBoxTable(["NAME", "VALUE", "FILES", "OTHER VALUES"]);
            for (const value of values) {
                table.push([
                    value.name,
                    truncateDisplay(value.value ?? "(unset)", 70),
                    String(value.files),
                    value.conflicts.length > 0 ? truncateDisplay(value.conflicts.join(", "), 30) : "—",
                ]);
            }

            out.println(table.toString());
            out.println(
                pc.dim("pass --deployed-env to resolve / check / carry / rank / find-commit, or these flags to build:")
            );
            out.println(flags.join(" "));
        });

    withBuildFlags(group.command("build"))
        .description(
            "build a commit with YOUR build command in a worktree and keep the output (with maps) in the cache"
        )
        .option("--project <name>", "cache folder name (default: the --repo folder name)")
        .option("--out <dir>", "also expose the build output here (a symlink into the cache)")
        .option("--json", "machine-readable result")
        .action(
            releasesWorktree(async (opts: BuildOpts & { out?: string }) => {
                const cache = new SourcemapCache(projectOf(opts));
                const builds = await localBuilds(cache, { ...opts, build: [] });
                const built = builds[0];
                if (!built) {
                    fail(
                        "nothing to build",
                        suggestCommand(CMD, { add: ["build", "--repo", ".", "--commit", "HEAD"] })
                    );
                }

                const id = basename(resolve(built.dir, ".."));
                // The view is the build output itself (the folder resolve --build takes), not the entry with its log.
                const link = opts.out ? await cache.linkOut(id, opts.out, "files") : null;
                if (opts.json) {
                    out.result({ dir: built.dir, files: built.files.length, link });
                    return;
                }

                out.println(
                    `${built.label}: ${built.files.length} JS files in ${built.dir}${link ? `\nlink: ${link}` : ""}`
                );
            })
        );

    withBuildFlags(withDeployedFlags(group.command("rank")))
        .description(
            "score how much of the deployed code each local build contains (which build matches the deployment)"
        )
        .action(
            releasesWorktree(async (opts: DeployedOpts & BuildOpts) => {
                const cache = new SourcemapCache(projectOf(opts));
                const snap = await deployedSource(cache, opts);
                const builds = await localBuilds(cache, opts, snap);
                const scores = [];
                for (const build of builds) {
                    scores.push(await scoreBuild({ deployed: snap, build }));
                }

                scores.sort((a, b) => a.deployedOnly.length - b.deployedOnly.length || b.rate - a.rate);
                if (opts.json) {
                    out.result(scores.map(({ chunks: _chunks, ...rest }) => rest));
                    return;
                }

                const table = createBoxTable([
                    "BUILD",
                    "CODE FOUND",
                    "MISSING CHUNKS",
                    "EXTRA CHUNKS",
                    "SAME DEBUG ID",
                ]);
                for (const score of scores) {
                    table.push([
                        score.label,
                        `${(100 * score.rate).toFixed(3)}%`,
                        String(score.deployedOnly.length),
                        String(score.localOnly.length),
                        score.debugIds.compared === 0 ? "—" : `${score.debugIds.equal}/${score.debugIds.compared}`,
                    ]);
                }

                out.println(table.toString());
            })
        );

    withBuildFlags(withDeployedFlags(group.command("find-commit")))
        .description(
            "find the commit a deployment was built from: one reference build, every commit ranked, the winner confirmed"
        )
        .requiredOption("--range <A..B>", "the deployed commit is after A and at or before B")
        .option("--base <ref>", "the reference build (default: the end of the range)")
        .option("--strategy [name]", `how to search: ${FIND_COMMIT_STRATEGIES.join(", ")} (default: tokens)`)
        .option("--no-verify", "tokens: skip the build that confirms the best-ranked commit")
        .option("--max-builds <n>", "rebuild: candidate builds besides the base", "8")
        .option("--all-parents", "walk merged branches too (default: first-parent only)")
        .addHelpText(
            "after",
            `
How it works (tokens, the default): build ONE reference commit. Minifiers keep string text and property
names, so for every commit in the range the deployed count of each such token is predicted from the
reference build plus that commit's source changes (no build per commit). The best fit wins, and one build
of it confirms that it contains more of the deployed code than the reference. Ties are reported as a span:
those commits put the same strings and names into the bundle. Commit shas the bundle itself contains are
shown as evidence only.
rebuild: trace the differing code through the reference build's maps to source files, then build every
commit that touched them (more builds, independent of tokens).

Examples:
  ${CMD} find-commit --deployed https://app.example.com/ --repo . --range v1.2.0..origin/main \\
      --build-cmd 'bun install --frozen-lockfile && bun run build' --output web/build --link .npmrc
  ${CMD} find-commit --deployed-dir ./downloaded-dist --project web --repo . --range HEAD~30..HEAD \\
      --build-cmd 'bun run build' --output dist --strategy rebuild`
        )
        .action(
            releasesWorktree(
                async (
                    opts: DeployedOpts &
                        BuildOpts & {
                            range: string;
                            base?: string;
                            strategy?: string | boolean;
                            verify?: boolean;
                            maxBuilds: string;
                            allParents?: boolean;
                        }
                ) => {
                    if (!opts.repo || !opts.buildCmd || !opts.output) {
                        fail("find-commit needs --repo, --build-cmd and --output");
                    }

                    const strategy = await pickEnumFlag({
                        tool: CMD,
                        subcommand: ["find-commit"],
                        flag: "--strategy",
                        given: opts.strategy,
                        values: FIND_COMMIT_STRATEGIES,
                        fallback: "tokens",
                        accepts: (value): value is FindCommitStrategy =>
                            (FIND_COMMIT_STRATEGIES as readonly string[]).includes(value),
                    });
                    if (!strategy) {
                        return;
                    }

                    const cache = new SourcemapCache(projectOf(opts));
                    const deployed = await deployedSource(cache, opts);
                    const spinner = out.spinner();
                    const started = performance.now();
                    spinner.start("building the reference");
                    const result = await findDeployedCommit({
                        cache,
                        deployed,
                        repo: resolve(opts.repo),
                        range: opts.range,
                        base: opts.base,
                        strategy,
                        verify: opts.verify,
                        buildCmd: opts.buildCmd,
                        outputDir: opts.output,
                        links: opts.link,
                        env: await buildEnv(opts, deployed),
                        worktree: opts.worktree
                            ? resolve(opts.worktree)
                            : opts.keepWorktree
                              ? managedWorktree(cache)
                              : undefined,
                        firstParent: !opts.allParents,
                        maxBuilds: Number(opts.maxBuilds),
                        onEvent: (event) => {
                            if (event.type === "build-start") {
                                spinner.message(`building ${event.commit.slice(0, 12)}`);
                            } else if (event.type === "ranked") {
                                spinner.message(`ranked by ${event.tokens} tokens; confirming the best`);
                            } else if (event.type === "changed-files") {
                                spinner.message(
                                    `${event.files.length} source files differ; asking git which commits touched them`
                                );
                            } else if (event.type === "scored") {
                                spinner.message(`${event.commit.slice(0, 12)}: ${(100 * event.rate).toFixed(3)}%`);
                            }
                        },
                    });
                    spinner.stop(`done in ${Math.round((performance.now() - started) / 1000)} s`);
                    if (opts.json) {
                        out.result({
                            ...result,
                            candidates: result.candidates.map(({ score: _score, ...rest }) => rest),
                        });
                        return;
                    }

                    renderCliHeader("Deployed commit", `${opts.range} · ${result.strategy}`);
                    if (result.ranking.length > 0) {
                        const ranking = createBoxTable(["COMMIT", "ERROR", "FILES", "SUBJECT"]);
                        for (const entry of result.ranking.slice(0, 10)) {
                            const id = entry.commit.slice(0, 12);
                            ranking.push([
                                result.equivalent.includes(entry.commit) ? pc.green(id) : id,
                                String(entry.error),
                                `${entry.changedFiles}${entry.lockfileDiffers ? " + lock" : ""}`,
                                truncateDisplay(await subjectLine(opts.repo, entry.commit), 60),
                            ]);
                        }

                        out.println(ranking.toString());
                        out.println(
                            pc.dim(
                                `ERROR: how far the commit's predicted string and property-name counts are from the deployment (${result.rankingTokens} tokens). FILES: bundled source files that differ from the reference.`
                            )
                        );
                    }

                    const builds = createBoxTable(["BUILD", "CODE FOUND", "MISSING CHUNKS", "SUBJECT"]);
                    for (const candidate of result.candidates) {
                        builds.push([
                            candidate.commit === result.best?.commit
                                ? pc.green(candidate.commit.slice(0, 12))
                                : candidate.commit.slice(0, 12),
                            `${(100 * candidate.rate).toFixed(3)}%`,
                            String(candidate.deployedOnly),
                            truncateDisplay(candidate.subject, 60),
                        ]);
                    }

                    out.println(builds.toString());
                    if (result.best) {
                        const span =
                            result.equivalent.length > 4
                                ? `${result.equivalent.length} commits, ${result.equivalent.at(-1)?.slice(0, 12)} (oldest) .. ${result.equivalent[0]?.slice(0, 12)} (newest)`
                                : result.equivalent.map((commit) => commit.slice(0, 12)).join(", ");
                        out.println(
                            pc.green(
                                `best: ${result.best.commit.slice(0, 12)} ${truncateDisplay(result.best.subject, 60)} (${result.confidence}, ${result.buildsUsed} build(s))${result.equivalent.length > 1 ? `\nsame strings in the bundle: ${span}` : ""}`
                            )
                        );
                    }

                    for (const note of result.notes) {
                        out.println(pc.yellow(`⚠ ${note}`));
                    }
                }
            )
        );

    group
        .command("cache")
        .description(
            `list or prune the cache (~/.genesis-tools/ts/sourcemaps/<project>/); prune removes entries unused for ${DEFAULT_MAX_AGE_DAYS} days, folders failed builds left, and a build worktree unused for an hour. Every write prunes its project too`
        )
        .argument("[action]", "list | prune", "list")
        .option("--project <name>", "which project's cache")
        .option("--all", "prune every project's cache")
        .option("--max-age-days <n>", "prune entries unused for longer than this", String(DEFAULT_MAX_AGE_DAYS))
        .option("--json", "machine-readable result")
        .action(
            async (action: string, opts: { project?: string; all?: boolean; maxAgeDays: string; json?: boolean }) => {
                if (action === "prune") {
                    await pruneCaches(opts);
                    return;
                }

                if (action !== "list") {
                    fail(`unknown action '${action}'`, `${CMD} cache list --project <name>`);
                }

                if (!opts.project) {
                    const known = await cacheProjects();
                    return fail(
                        `cache list needs --project <name>${known.length > 0 ? `; cached projects: ${known.join(", ")}` : ""}`,
                        `${CMD} cache list --project ${known[0] ?? "<name>"}`
                    );
                }

                const cache = new SourcemapCache(opts.project);
                const entries = await cache.list();
                if (opts.json) {
                    out.result(entries);
                    return;
                }

                const table = createBoxTable(["ID", "KIND", "LABEL", "SIZE", "LAST USED"]);
                for (const entry of entries) {
                    table.push([
                        entry.id,
                        entry.kind,
                        entry.label,
                        formatBytes(entry.bytes),
                        entry.lastUsedAt.slice(0, 16),
                    ]);
                }

                out.println(`${cache.dir}\n${table.toString()}`);
            }
        );
}
