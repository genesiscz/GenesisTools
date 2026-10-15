#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { runTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { spawnDetached } from "@genesiscz/utils/DashboardApp/detach";
import { formatBytes } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import { DASHBOARDS } from "@genesiscz/utils/ui/dashboards";
import { Command } from "commander";
import pc from "picocolors";
import { DETACH_WAIT_MS, detachedLogPath, waitForServedUrl } from "./lib/detach";
import { openArtifact, openLibrary } from "./lib/open";
import { RUNTIME_DIR } from "./lib/paths";
import { addEntry, entryUrlPath, loadRegistry, removeEntry, resolveTarget } from "./lib/registry";
import {
    findRunning,
    holdServer,
    isSignalable,
    LIBRARY_DIR,
    listRunning,
    removeRunning,
    runningOutsideRegistry,
} from "./lib/running";
import { describeShippedTemplates, resolveTemplateDir } from "./lib/templates";

const DEFAULT_PORT = DASHBOARDS.artifact.port;

/** `init --starter <name>`: the shipped starter files under runtime/starters. */
const STARTERS = { dashboard: "dashboard.tsx", report: "report.html", roadmap: "roadmap.tsx" } as const;
type StarterName = keyof typeof STARTERS;
const STARTER_NAMES: StarterName[] = ["dashboard", "report", "roadmap"];

function isStarterName(value: string): value is StarterName {
    return Object.hasOwn(STARTERS, value);
}

const program = new Command();

program
    .name("artifact")
    .description(
        "Serve or build folders of loose HTML/TSX/MD files as live local dashboards.\n" +
            "serve = Vite dev server (React + Tailwind preconfigured, HMR, no per-folder node_modules).\n" +
            "build = self-contained single-file HTML that works from file://."
    );

program
    .command("list")
    .description("List registered artifact folders")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
        const entries = loadRegistry();

        if (opts.json) {
            out.result(entries);

            return;
        }

        renderCliHeader("Artifact Folders", `registered with ${toolCommand("artifact")}`);
        const unregistered = runningOutsideRegistry(listRunning(), entries);

        if (entries.length === 0) {
            out.log.info(`No folders registered. \`${toolCommand("artifact serve")} <dir>\` registers automatically.`);
        } else {
            const table = createBoxTable(["NAME", "DIRECTORY", "ENTRY", "CREATED"]);

            for (const e of entries) {
                table.push([
                    pc.white(e.name),
                    e.dir,
                    e.entry ?? pc.dim("—"),
                    e.createdAt.slice(0, 16).replace("T", " "),
                ]);
            }

            out.println(table.toString());
        }

        if (unregistered.length > 0) {
            const folders = unregistered.map((server) => `${server.dir} (port ${server.port})`).join(", ");
            out.log.info(
                `Also serving ${unregistered.length} unregistered folder(s): ${folders}. See: ${toolCommand("artifact ps")}`
            );
        }
    });

program
    .command("add")
    .description("Register a folder")
    .argument("<dir>", "folder to register")
    .option("--name <name>", "registry name (default: folder basename)")
    .option("--entry <file>", "default entry file, relative to the folder")
    .action((dir: string, opts: { name?: string; entry?: string }) => {
        const { entry, created } = addEntry({ dir, name: opts.name, entry: opts.entry });
        out.log.success(`${created ? "Registered" : "Already registered"} ${pc.bold(entry.name)} → ${entry.dir}`);
    });

program
    .command("remove")
    .alias("rm")
    .description("Remove a registered folder (the folder itself is untouched)")
    .argument("<name>", "registry name")
    .action((name: string) => {
        const removed = removeEntry(name);

        if (!removed) {
            out.log.error(`No registered folder named "${name}". See: ${toolCommand("artifact list")}`);
            process.exitCode = 1;

            return;
        }

        out.log.success(`Removed ${pc.bold(removed.name)} (${removed.dir})`);
    });

program
    .command("serve")
    .description(
        "Serve a folder (registered name, path, or a single artifact file; default: cwd). Run it several times for several folders."
    )
    .argument("[target]", "registered name, directory, or a single .tsx/.html/.md file")
    .option("--port <port>", "dev server port (auto-bumps when busy)", String(DEFAULT_PORT))
    .option("--host <host>", "bind address", "127.0.0.1")
    .option("--template <nameOrDir>", "page-chrome template (shipped name or a directory)")
    .option("--no-open", "do not open the browser")
    .option("--no-register", "do not auto-register the folder")
    .option("--detach", "daemonize: spawn the server detached and return (agent shells reap `nohup … &` children)")
    .action(
        async (
            target: string | undefined,
            opts: {
                port: string;
                host: string;
                template?: string;
                open: boolean;
                register: boolean;
                detach?: boolean;
            }
        ) => {
            if (opts.detach) {
                const logPath = detachedLogPath();
                const argvRest = process.argv.slice(1).filter((a) => a !== "--detach");
                // Its own session (setsid): a Codex or agent shell kills the command's whole process group when the
                // command returns, and a plain child died with it (2026-10-16: empty log, no server, a 404).
                const child = spawnDetached({ cmd: [process.execPath, ...argvRest, "--no-open"], logFile: logPath });
                let exitCode: number | null = null;
                void child.exited.then((exit) => {
                    exitCode = exit.code ?? 1;
                });
                const readLog = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
                const outcome = await waitForServedUrl({ readLog, exitCode: () => exitCode });

                if (outcome.kind === "serving") {
                    const moved = outcome.port !== Number.parseInt(opts.port, 10);
                    out.log.success(
                        `Detached server pid ${child.pid}: ${pc.cyan(outcome.url)}${moved ? pc.yellow(` (port ${opts.port} was busy)`) : ""}`
                    );
                    out.log.info(
                        `Log: ${logPath} · status: ${toolCommand("artifact ps")} · stop: ${toolCommand("artifact stop")} ${outcome.port}`
                    );
                    return;
                }

                const tail = readLog().trim().split("\n").slice(-8).join("\n");
                if (outcome.kind === "pending") {
                    out.log.warn(
                        `Startup is still pending for pid ${child.pid} after ${DETACH_WAIT_MS / 1000} s. Log: ${logPath}\n${tail}`
                    );
                    out.log.info(
                        `Check ${toolCommand("artifact ps")} before retrying, or stop this launch with: kill ${child.pid}`
                    );
                    return;
                }

                out.log.error(`The detached server exited (code ${outcome.code}) before it served anything:\n${tail}`);
                process.exitCode = 1;
                return;
            }

            const { serveArtifacts } = await import("./lib/serve");
            const resolved = resolveTarget(target);
            let name = resolved.registryEntry?.name ?? basename(resolved.dir);

            // Single-file targets don't auto-register their parent dir (it may be
            // ~/Downloads or a vault root); a dir target registers as before.
            if (opts.register && !resolved.registryEntry && !resolved.entry) {
                const { entry } = addEntry({ dir: resolved.dir });
                name = entry.name;
                out.log.info(`Registered as ${pc.bold(entry.name)}`);
            }

            const server = await serveArtifacts({
                dir: resolved.dir,
                port: Number.parseInt(opts.port, 10),
                host: opts.host,
                templateDir: resolveTemplateDir(opts.template),
            });
            const url = server.resolvedUrls?.local[0] ?? `http://${opts.host}:${opts.port}/`;
            const actualPort = Number.parseInt(new URL(url).port, 10) || Number.parseInt(opts.port, 10);
            const openUrl = resolved.entry ? url.replace(/\/$/, "") + entryUrlPath(resolved.entry) : url;
            out.log.success(`Serving ${pc.bold(resolved.entry ? join(resolved.dir, resolved.entry) : resolved.dir)}`);
            out.log.info(
                `${pc.cyan(openUrl)} ${pc.dim(`(catalog at / or /__catalog; Ctrl-C stops, or: ${toolCommand("artifact stop")} ${actualPort})`)}`
            );

            const cleanUrls = readdirSync(resolved.dir)
                .filter((f) => /\.(tsx|jsx|html|md)$/.test(f) && !f.startsWith("."))
                .slice(0, 3)
                .map((f) => entryUrlPath(f));

            if (cleanUrls.length > 0 && !resolved.entry) {
                out.log.info(pc.dim(`clean URLs: ${cleanUrls.map((r) => url.replace(/\/$/, "") + r).join("  ")}`));
            }

            await holdServer({
                port: actualPort,
                dir: resolved.dir,
                name,
                close: () => server.close(),
                openUrl: opts.open ? openUrl : undefined,
            });
        }
    );

program
    .command("ps")
    .description("List running artifact servers")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
        const servers = listRunning();

        if (opts.json) {
            out.result(servers);

            return;
        }

        renderCliHeader("Running Artifact Servers", `${toolCommand("artifact serve")} processes`);

        if (servers.length === 0) {
            out.log.info("None running.");

            return;
        }

        const table = createBoxTable(["NAME", "PORT", "PID", "DIRECTORY"]);

        for (const s of servers) {
            table.push([pc.white(s.name), pc.cyan(String(s.port)), String(s.pid), s.dir]);
        }

        out.println(table.toString());
    });

program
    .command("open")
    .description("Open an artifact in the browser, starting its server first when none is running")
    .argument("<target>", "registered name, directory, or a single artifact file")
    .argument("[page]", "page inside the artifact, e.g. report or data/view (default: the catalog)")
    .option("--timeout <seconds>", "how long to wait for a starting server", "20")
    .action(async (target: string, page: string | undefined, opts: { timeout: string }) => {
        try {
            const result = await openArtifact({ target, path: page, timeoutMs: Number(opts.timeout) * 1000 });
            out.log.success(`${result.started ? "Started and opened" : "Opened"} ${result.url}`);
        } catch (error) {
            out.log.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("gallery")
    .description(
        "Open the kit component gallery in the browser, starting the library server when none runs. A name opens that page."
    )
    .argument("[component...]", "page or component name, fuzzy and case-insensitive: gantt, time series, datatable")
    .option("--list", "print the pages grouped by family and exit")
    .option("--no-open", "start the server when needed and print the URL instead of opening it")
    .option("--port <port>", `library port (default: a running library, else ${DASHBOARDS["artifact-library"].port})`)
    .option("--timeout <seconds>", "how long to wait for a starting server", "20")
    .action(async (words: string[], opts: { list?: boolean; open: boolean; port?: string; timeout: string }) => {
        const { galleryPath, loadGalleryEntries } = await import("./lib/gallery");
        const { groupByFamily, matchGalleryEntry } = await import("./gallery/_entries");
        const query = words.join(" ").trim();

        if (opts.port !== undefined && !/^\d+$/.test(opts.port)) {
            out.log.error(`--port must be a number (got "${opts.port}").`);
            process.exitCode = 1;

            return;
        }

        const entries = opts.list || query ? await loadGalleryEntries() : [];

        if (opts.list) {
            const width = Math.max(...entries.map((e) => e.id.length));

            for (const group of groupByFamily(entries)) {
                out.println(pc.bold(group.family));

                for (const e of group.entries) {
                    out.println(
                        `  ${pc.cyan(e.id.padEnd(width))}  ${e.title}${e.summary ? pc.dim(`. ${e.summary}`) : ""}`
                    );
                }
            }

            out.println(pc.dim(`\nOpen one: ${toolCommand("artifact gallery")} <name>`));

            return;
        }

        const match = query ? matchGalleryEntry(entries, query) : undefined;

        if (query && !match) {
            out.log.error(`No gallery page matches "${query}". See: ${toolCommand("artifact gallery")} --list`);
            process.exitCode = 1;

            return;
        }

        try {
            const result = await openLibrary({
                path: galleryPath(match?.id),
                port: opts.port === undefined ? undefined : Number(opts.port),
                defaultPort: DASHBOARDS["artifact-library"].port,
                open: opts.open,
                timeoutMs: Number(opts.timeout) * 1000,
            });

            if (!opts.open) {
                out.print(`${result.url}\n`);

                return;
            }

            const page = match ? ` (${match.title})` : "";
            out.log.success(`${result.started ? "Started the library and opened" : "Opened"} ${result.url}${page}`);
        } catch (error) {
            out.log.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });

program
    .command("stop")
    .description("Stop a running artifact server by name, directory, or port")
    .argument("<target>", "name, directory, or port")
    .action(async (target: string) => {
        const match = findRunning(target);

        if (!match) {
            out.log.error(`No running server matches "${target}". See: ${toolCommand("artifact ps")}`);
            process.exitCode = 1;

            return;
        }

        const { server, identity } = match;

        if (!isSignalable(identity)) {
            // The pid outlived the server and the OS reissued it. Signalling now
            // would kill a stranger's process, so drop the stale record instead.
            await removeRunning(server.pid);
            out.log.warn(
                `${pc.bold(server.name)} is no longer running under pid ${server.pid}; dropped the stale record without signalling.`
            );

            return;
        }

        // isSignalable() above required the identity findRunning already
        // computed to be "live": alive, and matching the command line recorded
        // when the server registered itself.
        // pid-verified: identity confirmed against the command recorded at write time.
        process.kill(server.pid, "SIGTERM");
        await removeRunning(server.pid);
        out.log.success(`Stopped ${pc.bold(server.name)} (pid ${server.pid}, port ${server.port})`);
    });

program
    .command("init")
    .description(
        "Scaffold a starter artifact at the given path — any <name>.html (report shape, with data.json) or <name>.tsx (kit dashboard shape)"
    )
    .argument("<file>", "target file to create (any name ending .html or .tsx)")
    .option("--starter [name]", `starter page: ${STARTER_NAMES.join(", ")} (default: by file extension)`)
    .action(async (file: string, opts: { starter?: string | boolean }) => {
        const target = resolve(file);

        if (existsSync(target)) {
            out.log.error(`${target} already exists — refusing to overwrite.`);
            process.exitCode = 1;

            return;
        }

        const ext = extname(target);
        const named = typeof opts.starter === "string" ? opts.starter : undefined;

        if (opts.starter !== undefined && (!named || !isStarterName(named))) {
            out.log.error(
                `--starter ${named ? `does not accept "${named}"` : "requires a value"}. Possible: ${STARTER_NAMES.join(", ")}. Example: ${toolCommand("artifact init")} plan.tsx --starter roadmap`
            );
            process.exitCode = 1;

            return;
        }

        const starter =
            named && isStarterName(named)
                ? STARTERS[named]
                : ext === ".tsx"
                  ? "dashboard.tsx"
                  : ext === ".html"
                    ? "report.html"
                    : null;

        if (!starter) {
            out.log.error(`init supports .html and .tsx targets (got "${ext}").`);
            process.exitCode = 1;

            return;
        }

        if (extname(starter) !== ext) {
            out.log.error(
                `The ${named} starter is a ${extname(starter)} page; name the target <name>${extname(starter)}.`
            );
            process.exitCode = 1;

            return;
        }

        const title = basename(target, ext).replaceAll("-", " ");
        const content = readFileSync(join(RUNTIME_DIR, "starters", starter), "utf8").replaceAll("{{TITLE}}", title);
        await Bun.write(target, content);
        out.log.success(`Created ${pc.bold(target)} from the ${starter} starter.`);

        // The report starter fetches ./data.json (silently falling back to its inline
        // sample) — ship the sample file too, so edits to it are live from minute one.
        const dataPath = join(resolve(target, ".."), "data.json");

        if (starter === "report.html" && !existsSync(dataPath)) {
            const sample = {
                stats: [
                    { label: "sample stat", value: "42" },
                    { label: "another", value: "7/9" },
                ],
                rows: [{ item: "sample row", status: "ok", value: "1.21" }],
            };
            await Bun.write(dataPath, `${SafeJSON.stringify(sample, { strict: true }, 4)}\n`);
            out.log.info(`Created ${pc.bold(dataPath)} (the starter fetches it — put your numbers there).`);
        }

        out.log.info(`Serve it: ${toolCommand("artifact serve")} ${pc.dim(resolve(target, ".."))}`);
    });

const library = program.command("library").description("The artifact library — every registered folder on ONE server");

library
    .command("up", { isDefault: true })
    .description("Start the library server: / lists all registered artifacts; each mounts at /a/<name>/")
    .option("--port <port>", "library port", String(DASHBOARDS["artifact-library"].port))
    .option("--host <host>", "bind address", "127.0.0.1")
    .option("--template <nameOrDir>", "page-chrome template")
    .option("--no-open", "do not open the browser")
    .action(async (opts: { port: string; host: string; template?: string; open: boolean }) => {
        const { startLibrary } = await import("./lib/library");
        const port = Number.parseInt(opts.port, 10);
        const library = await startLibrary({ port, host: opts.host, templateDir: resolveTemplateDir(opts.template) });
        const url = `http://${opts.host}:${library.port}/`;

        out.log.success(`Artifact library up: ${pc.cyan(url)} ${pc.dim("(every registered folder, one server)")}`);

        await holdServer({
            port: library.port,
            dir: LIBRARY_DIR,
            name: "library",
            close: () => library.close(),
            openUrl: opts.open ? url : undefined,
        });
    });

program
    .command("templates")
    .description("List the shipped page/kit templates (use with serve --template <name>)")
    .action(() => {
        renderCliHeader("Artifact Templates", "serve/library --template <name>");
        const table = createBoxTable(["NAME", "PERSONALITY"]);

        for (const t of describeShippedTemplates()) {
            table.push([pc.white(t.name === "default" ? "default (graphite)" : t.name), t.personality]);
        }

        out.println(table.toString());
    });

program
    .command("kit")
    .alias("api")
    .description("Print the @artifact/kit typed API (generated .d.ts) — author against it without reading source")
    .argument("[names...]", "print only declarations mentioning these names (e.g. Tabs DayChart QA)")
    .action(async (names: string[]) => {
        const { filterKitDts, kitApiDts } = await import("./lib/kit-types");
        const dts = await kitApiDts();
        out.print(names.length > 0 ? filterKitDts(dts, names) : dts);
    });

program
    .command("types")
    .description(
        "Write an OPTIONAL tsconfig.json into an artifact folder for editor IntelliSense (runtime never needs it)"
    )
    .argument("[dir]", "artifact folder (default: cwd)")
    .action(async (dir: string | undefined) => {
        const { writeEditorTsconfig } = await import("./lib/kit-types");
        const result = await writeEditorTsconfig(resolve(dir ?? process.cwd()));

        if (result.created) {
            out.log.success(`Wrote ${pc.bold(result.path)} (editor-only; safe to delete or gitignore).`);

            return;
        }

        out.log.info(`${result.path} already exists — left untouched.`);
    });

program
    .command("build")
    .description("Build a self-contained single-file HTML artifact (works from file://)")
    .argument("[target]", "registered name, directory, or a single artifact file (default: cwd)")
    .option("-e, --entry <file>", "entry file, relative to the folder")
    .option("-o, --out <file>", "output path (default: <dir>/dist/<entry>)")
    .option("--max-embed <mb>", "per-file cap for embedded sibling data files", "5")
    .option("--max-embed-total <mb>", "cap on the embedded sibling data files taken together", "32")
    .option("--embed <scope>", "referenced (only files the entry names) or tree (every sibling data file)")
    .option("-t, --template <name>", "theme: a markdown entry's page chrome, or a .tsx build's tokens (e.g. auto)")
    .option("--watch", "stay running and rebuild on every source change")
    .action(
        async (
            target: string | undefined,
            opts: {
                entry?: string;
                out?: string;
                maxEmbed: string;
                maxEmbedTotal: string;
                embed?: string;
                template?: string;
                watch?: boolean;
            }
        ) => {
            if (opts.embed && opts.embed !== "referenced" && opts.embed !== "tree") {
                out.log.error(`--embed must be "referenced" or "tree" (got "${opts.embed}").`);
                process.exitCode = 1;

                return;
            }

            const { buildSingleFile, embedScopeFor, resolveEntry, watchAndRebuild } = await import("./lib/build");
            const resolved = resolveTarget(target);
            const entry = resolveEntry(resolved.dir, opts.entry ?? resolved.entry ?? resolved.registryEntry?.entry);
            const buildOpts = {
                dir: resolved.dir,
                entry,
                out: opts.out,
                templateDir: resolveTemplateDir(opts.template),
                embedLimitMb: Number.parseFloat(opts.maxEmbed),
                embedTotalMb: Number.parseFloat(opts.maxEmbedTotal),
                embedScope:
                    (opts.embed as "referenced" | "tree" | undefined) ??
                    embedScopeFor({
                        fileTargetEntry: resolved.entry,
                        entryFlag: opts.entry,
                        registryEntry: resolved.registryEntry?.entry,
                    }),
            };
            const report = (result: Awaited<ReturnType<typeof buildSingleFile>>): void => {
                out.log.success(
                    `Built ${pc.bold(result.outPath)} (${formatBytes(result.bytes)}, ` +
                        `${result.bundled ? "bundled" : "no local assets — source passed through"}, ` +
                        `${result.embedded.length} file(s) embedded for file:// fetch)`
                );

                for (const skip of result.skippedEmbeds) {
                    const cause = skip.reason === "budget" ? "--max-embed-total reached" : "over --max-embed";
                    out.log.warn(`NOT embedded (${cause}): ${skip.rel} (${formatBytes(skip.sizeBytes)})`);
                }
            };

            report(await buildSingleFile(buildOpts));

            if (opts.watch) {
                watchAndRebuild(buildOpts, report);
                out.log.info(`Watching ${pc.bold(resolved.dir)} — rebuilding on change (Ctrl-C stops).`);
                await new Promise(() => {});
            }
        }
    );

await runTool(program, { tool: "artifact" });
