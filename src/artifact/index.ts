#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { runTool } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { formatBytes } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader } from "@genesiscz/utils/table";
import { DASHBOARDS } from "@genesiscz/utils/ui/dashboards";
import { Command } from "commander";
import pc from "picocolors";
import { buildSingleFile, embedScopeFor, resolveEntry, watchAndRebuild } from "./lib/build";
import { filterKitDts, kitApiDts, writeEditorTsconfig } from "./lib/kit-types";
import { startLibrary } from "./lib/library";
import { addEntry, loadRegistry, removeEntry, resolveTarget } from "./lib/registry";
import { findRunning, isSignalable, listRunning, recordRunning, removeRunning } from "./lib/running";
import { serveArtifacts } from "./lib/serve";
import { describeShippedTemplates, resolveTemplateDir } from "./lib/templates";
import { RUNTIME_DIR } from "./lib/vite";

const DEFAULT_PORT = DASHBOARDS.artifact.port;

/** Serve route for a single-file entry: the clean extension-less URL. */
function entryRoute(entry: string): string {
    return `/${entry.replace(/\.(tsx|jsx|html|md)$/, "")}`;
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

        renderCliHeader("Artifact Folders", "registered with tools artifact");

        if (entries.length === 0) {
            out.log.info("No folders registered. `tools artifact serve <dir>` registers automatically.");

            return;
        }

        const table = createBoxTable(["NAME", "DIRECTORY", "ENTRY", "CREATED"]);

        for (const e of entries) {
            table.push([pc.white(e.name), e.dir, e.entry ?? pc.dim("—"), e.createdAt.slice(0, 16).replace("T", " ")]);
        }

        out.println(table.toString());
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
            out.log.error(`No registered folder named "${name}". See: tools artifact list`);
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
                const logPath = join(tmpdir(), `artifact-serve-${opts.port}.log`);
                const argvRest = process.argv.slice(1).filter((a) => a !== "--detach");
                const child = Bun.spawn([process.execPath, ...argvRest, "--no-open"], {
                    stdout: Bun.file(logPath),
                    stderr: Bun.file(logPath),
                    env: env.getProcessEnv(),
                });
                child.unref();
                out.log.success(`Detached server pid ${child.pid} (requested port ${opts.port}).`);
                out.log.info(`Log: ${logPath} · status: tools artifact ps · stop: tools artifact stop ${opts.port}`);

                return;
            }

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
            await recordRunning({
                pid: process.pid,
                port: actualPort,
                dir: resolved.dir,
                name,
                startedAt: new Date().toISOString(),
            });

            // Vite holds file watchers, the HTTP listener and HMR sockets; closing
            // it first lets them unwind instead of being torn down by exit().
            const cleanup = (): void => {
                void server
                    .close()
                    .catch((err: unknown) => {
                        logger.debug({ err }, "[artifact] serve: closing the dev server failed on shutdown");
                    })
                    .then(() => removeRunning(process.pid))
                    .finally(() => process.exit(0));
            };
            process.on("SIGINT", cleanup);
            process.on("SIGTERM", cleanup);

            const openUrl = resolved.entry ? url.replace(/\/$/, "") + entryRoute(resolved.entry) : url;
            out.log.success(`Serving ${pc.bold(resolved.entry ? join(resolved.dir, resolved.entry) : resolved.dir)}`);
            out.log.info(
                `${pc.cyan(openUrl)} ${pc.dim("(catalog at /__catalog; Ctrl-C stops, or: tools artifact stop " + actualPort + ")")}`
            );

            const cleanUrls = readdirSync(resolved.dir)
                .filter((f) => /\.(tsx|jsx|html|md)$/.test(f) && !f.startsWith("."))
                .slice(0, 3)
                .map((f) => entryRoute(f));

            if (cleanUrls.length > 0 && !resolved.entry) {
                out.log.info(pc.dim(`clean URLs: ${cleanUrls.map((r) => url.replace(/\/$/, "") + r).join("  ")}`));
            }

            if (opts.open && process.platform === "darwin") {
                Bun.spawn(["open", openUrl], { stdout: "ignore", stderr: "ignore" });
            }

            await new Promise(() => {});
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

        renderCliHeader("Running Artifact Servers", "tools artifact serve processes");

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
    .command("stop")
    .description("Stop a running artifact server by name, directory, or port")
    .argument("<target>", "name, directory, or port")
    .action(async (target: string) => {
        const server = findRunning(target);

        if (!server) {
            out.log.error(`No running server matches "${target}". See: tools artifact ps`);
            process.exitCode = 1;

            return;
        }

        if (!isSignalable(server)) {
            // The pid outlived the server and the OS reissued it. Signalling now
            // would kill a stranger's process, so drop the stale record instead.
            await removeRunning(server.pid);
            out.log.warn(
                `${pc.bold(server.name)} is no longer running under pid ${server.pid}; dropped the stale record without signalling.`
            );

            return;
        }

        // isSignalable() above required classifyPid to return "live", matching the
        // command line recorded when the server registered itself.
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
    .action(async (file: string) => {
        const target = resolve(file);

        if (existsSync(target)) {
            out.log.error(`${target} already exists — refusing to overwrite.`);
            process.exitCode = 1;

            return;
        }

        const ext = extname(target);
        const starter = ext === ".tsx" ? "dashboard.tsx" : ext === ".html" ? "report.html" : null;

        if (!starter) {
            out.log.error(`init supports .html and .tsx targets (got "${ext}").`);
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

        out.log.info(`Serve it: tools artifact serve ${pc.dim(resolve(target, ".."))}`);
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
        const port = Number.parseInt(opts.port, 10);
        const library = await startLibrary({ port, host: opts.host, templateDir: resolveTemplateDir(opts.template) });
        const url = `http://${opts.host}:${library.port}/`;
        await recordRunning({
            pid: process.pid,
            port: library.port,
            dir: "(library)",
            name: "library",
            startedAt: new Date().toISOString(),
        });

        // Same reason as `serve`: the mounts hold Vite watchers and HMR sockets.
        const cleanup = (): void => {
            void library
                .close()
                .catch((err: unknown) => {
                    logger.debug({ err }, "[artifact] library: closing the server failed on shutdown");
                })
                .then(() => removeRunning(process.pid))
                .finally(() => process.exit(0));
        };
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);

        out.log.success(`Artifact library up: ${pc.cyan(url)} ${pc.dim("(every registered folder, one server)")}`);

        if (opts.open && process.platform === "darwin") {
            Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
        }

        await new Promise(() => {});
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
    .option("--embed <scope>", "referenced (only files the entry names) or tree (every sibling data file)")
    .option("-t, --template <name>", "theme for a markdown entry's page chrome")
    .option("--watch", "stay running and rebuild on every source change")
    .action(
        async (
            target: string | undefined,
            opts: {
                entry?: string;
                out?: string;
                maxEmbed: string;
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

            const resolved = resolveTarget(target);
            const entry = resolveEntry(resolved.dir, opts.entry ?? resolved.entry ?? resolved.registryEntry?.entry);
            const buildOpts = {
                dir: resolved.dir,
                entry,
                out: opts.out,
                templateDir: resolveTemplateDir(opts.template),
                embedLimitMb: Number.parseFloat(opts.maxEmbed),
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
                    out.log.warn(`NOT embedded (over --max-embed): ${skip.rel} (${formatBytes(skip.sizeBytes)})`);
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
