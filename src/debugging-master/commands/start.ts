import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { ensureDashboardBuilt } from "@app/debugging-master/commands/dashboard";
import { startServer } from "@app/debugging-master/core/http-server";
import { SessionManager } from "@app/debugging-master/core/session-manager";
import type { ProjectConfig } from "@app/debugging-master/types";
import { out } from "@app/logger";
import { suggestCommand } from "@app/utils/cli/executor";
import { formatRelativeTime } from "@app/utils/format";
import { getLocalIpv4 } from "@app/utils/network";
import { renderQr } from "@app/utils/qr";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

const TOOL_NAME = "tools debugging-master";

type Language = ProjectConfig["language"];

const SNIPPET_EXT: Record<Language, string> = {
    typescript: "llm-log.ts",
    php: "llm-log.php",
};

function detectLanguage(projectPath: string): Language {
    if (existsSync(join(projectPath, "tsconfig.json"))) {
        return "typescript";
    }
    if (existsSync(join(projectPath, "composer.json"))) {
        return "php";
    }
    return "typescript";
}

function resolveSnippetSource(language: Language): string {
    return resolve(import.meta.dir, "../../utils/debugging-master", SNIPPET_EXT[language]);
}

export function registerStartCommand(program: Command): void {
    program
        .command("start")
        .description("Configure a project and start a debugging session")
        .option("--path <dir>", "Directory to place the instrumentation snippet")
        .option("--language <lang>", "Language: typescript or php")
        .option("--serve", "Start HTTP ingest server")
        .option("--port <n>", "HTTP server port", "7243")
        .action(async (opts: { path?: string; language?: string; serve?: boolean; port: string }) => {
            const globalOpts = program.opts<{ session?: string }>();
            const projectPath = process.cwd();
            const port = Number.parseInt(opts.port, 10);
            if (Number.isNaN(port) || port < 1 || port > 65535) {
                out.error(`Invalid port: ${opts.port}`);
                process.exit(1);
            }

            // --- Resolve session name ---
            let sessionName = globalOpts.session;

            if (sessionName && /[^a-zA-Z0-9_-]/.test(sessionName)) {
                out.error("Invalid session name. Use only alphanumeric characters, hyphens, and underscores.");
                process.exit(1);
            }

            if (!sessionName) {
                if (!process.stdout.isTTY) {
                    out.error(
                        `Error: --session <name> is required in non-interactive mode.\n` +
                            `  ${suggestCommand(TOOL_NAME, { add: ["--session", "<name>"] })}`
                    );
                    process.exit(1);
                }

                p.intro(pc.bold("debugging-master start"));

                const nameResult = await p.text({
                    message: "Session name",
                    placeholder: basename(projectPath),
                    validate(v: string | undefined) {
                        if (!v?.trim()) {
                            return "Session name is required";
                        }
                        if (/[^a-zA-Z0-9_-]/.test(v)) {
                            return "Use only alphanumeric, hyphens, underscores";
                        }
                    },
                });

                if (p.isCancel(nameResult)) {
                    p.cancel("Cancelled");
                    process.exit(0);
                }

                sessionName = nameResult;
            }

            // --- Resolve language ---
            let language: Language;

            if (opts.language) {
                if (opts.language !== "typescript" && opts.language !== "php") {
                    out.error(`Invalid language "${opts.language}". Supported: typescript, php`);
                    process.exit(1);
                }
                language = opts.language;
            } else {
                language = detectLanguage(projectPath);
            }

            // --- Resolve snippet destination ---
            const snippetDir = opts.path ? resolve(opts.path) : projectPath;
            const snippetFilename = SNIPPET_EXT[language];
            const snippetDest = join(snippetDir, snippetFilename);

            // --- Copy snippet ---
            if (!existsSync(snippetDir)) {
                out.error(`Snippet destination directory does not exist: ${snippetDir}`);
                process.exit(1);
            }

            const snippetSrc = resolveSnippetSource(language);

            if (!existsSync(snippetSrc)) {
                out.error(`Snippet source not found: ${snippetSrc}`);
                process.exit(1);
            }

            copyFileSync(snippetSrc, snippetDest);

            // Substitute __LAN_IP__ placeholder so cross-device logging works out of the box.
            const lanIp = getLocalIpv4();
            if (lanIp) {
                const snippetContent = readFileSync(snippetDest, "utf-8");
                if (snippetContent.includes("__LAN_IP__")) {
                    writeFileSync(snippetDest, snippetContent.replaceAll("__LAN_IP__", lanIp));
                }
            }

            // --- Create session ---
            const sm = new SessionManager();
            const { jsonlPath, reused } = await sm.createSession(sessionName, projectPath, {
                serve: opts.serve,
                port: opts.serve ? port : undefined,
            });

            // --- Save project config ---
            const cm = sm.getConfig();
            await cm.setProject(projectPath, {
                snippetPath: snippetDest,
                language,
            });

            // --- Output ---
            const relSnippet = relative(projectPath, snippetDest);
            const importPath = `./${relSnippet.replace(/\.(ts|php)$/, "")}`;

            out.println("");
            if (reused) {
                const lastLog = reused.lastLogAt
                    ? `${formatRelativeTime(new Date(reused.lastLogAt))} (${reused.totalLogs} total)`
                    : "no logs yet";
                const startup = formatRelativeTime(new Date(reused.createdAt));
                out.println(pc.yellow(`⚠ Session re-used. Last log ${lastLog}, started ${startup}`));
            } else {
                out.println(pc.green(pc.bold("Session created")));
            }

            out.println("");
            out.println(`  ${pc.dim("Session:")}   ${sessionName}`);
            out.println(`  ${pc.dim("Project:")}   ${projectPath}`);
            out.println(`  ${pc.dim("Language:")}  ${language}`);
            out.println(`  ${pc.dim("Snippet:")}   ${relSnippet}`);
            out.println(`  ${pc.dim("Log file:")}  ${jsonlPath}`);
            out.println("");

            if (language === "typescript") {
                out.println(pc.dim("Add to your code:"));
                out.println(`  import { dbg } from '${importPath}';`);
                out.println(`  dbg.session('${sessionName}');`);
            } else {
                out.println(pc.dim("Add to your code:"));
                out.println(`  require_once __DIR__ . '/${relSnippet}';`);
                out.println(`  LlmLog::session('${sessionName}');`);
            }

            out.println("");
            out.println(pc.dim("Next steps:"));
            out.println(`  ${suggestCommand(TOOL_NAME, { replaceCommand: ["tail", "--session", sessionName] })}`);
            out.println(`  ${suggestCommand(TOOL_NAME, { replaceCommand: ["get", "--session", sessionName] })}`);
            out.println("");

            // --- Optionally start HTTP server ---
            if (opts.serve) {
                await ensureDashboardBuilt();

                let actualPort: number;
                let serverReused = false;

                try {
                    ({ port: actualPort } = startServer(port));
                } catch {
                    // Port busy — check if it's already our server
                    try {
                        const res = await fetch(`http://127.0.0.1:${port}/health`);
                        const body = (await res.json()) as { status?: string };

                        if (res.ok && body.status === "ok") {
                            actualPort = port;
                            serverReused = true;
                        } else {
                            out.error(`Port ${port} is in use by another process`);
                            process.exit(1);
                        }
                    } catch {
                        out.error(`Port ${port} is in use by another process`);
                        process.exit(1);
                    }
                }

                if (serverReused) {
                    out.println(pc.green(`Reusing HTTP server on port ${actualPort}`));
                } else {
                    out.println(pc.green(`HTTP server listening on port ${actualPort}`));
                }

                const lanIp = getLocalIpv4();
                const dashboardUrl = `http://${lanIp}:${actualPort}/`;
                out.println(pc.dim(`  ingest:    POST http://${lanIp}:${actualPort}/log/${sessionName}`));
                out.println(pc.dim(`  health:    GET  http://${lanIp}:${actualPort}/health`));
                out.println(`  ${pc.bold(pc.yellow("dashboard:"))} ${pc.bold(dashboardUrl)}`);
                out.println("");
                out.println(pc.dim("  scan from your phone:"));
                out.println(renderQr(dashboardUrl, { small: true }));

                if (!serverReused) {
                    // Keep process alive only if we own the server
                    await new Promise(() => {});
                }
            }
        });
}
