import type { Command } from "commander";
import { existsSync, copyFileSync } from "node:fs";
import { resolve, join, relative, basename } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { SessionManager } from "@app/debugging-master/core/session-manager";
import { startServer } from "@app/debugging-master/core/http-server";
import { suggestCommand } from "@app/utils/cli/executor";
import type { ProjectConfig } from "@app/debugging-master/types";

const TOOL_NAME = "tools debugging-master";

type Language = ProjectConfig["language"];

const SNIPPET_EXT: Record<Language, string> = {
	typescript: "llm-log.ts",
	php: "llm-log.php",
};

function detectLanguage(projectPath: string): Language {
	if (existsSync(join(projectPath, "tsconfig.json"))) return "typescript";
	if (existsSync(join(projectPath, "composer.json"))) return "php";
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
				console.error(`Invalid port: ${opts.port}`);
				process.exit(1);
			}

			// --- Resolve session name ---
			let sessionName = globalOpts.session;

			if (sessionName && /[^a-zA-Z0-9_-]/.test(sessionName)) {
				console.error("Invalid session name. Use only alphanumeric characters, hyphens, and underscores.");
				process.exit(1);
			}

			if (!sessionName) {
				if (!process.stdout.isTTY) {
					console.error(
						`Error: --session <name> is required in non-interactive mode.\n` +
						`  ${suggestCommand(TOOL_NAME, { add: ["--session", "<name>"] })}`,
					);
					process.exit(1);
				}

				p.intro(pc.bold("debugging-master start"));

				const nameResult = await p.text({
					message: "Session name",
					placeholder: basename(projectPath),
					validate(v: string | undefined) {
						if (!v?.trim()) return "Session name is required";
						if (/[^a-zA-Z0-9_-]/.test(v)) return "Use only alphanumeric, hyphens, underscores";
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
					console.error(`Invalid language "${opts.language}". Supported: typescript, php`);
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
				console.error(`Snippet destination directory does not exist: ${snippetDir}`);
				process.exit(1);
			}

			const snippetSrc = resolveSnippetSource(language);

			if (!existsSync(snippetSrc)) {
				console.error(`Snippet source not found: ${snippetSrc}`);
				process.exit(1);
			}

			copyFileSync(snippetSrc, snippetDest);

			// --- Create session ---
			const sm = new SessionManager();
			const jsonlPath = await sm.createSession(sessionName, projectPath, {
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

			console.log("");
			console.log(pc.green(pc.bold("Session created")));
			console.log("");
			console.log(`  ${pc.dim("Session:")}   ${sessionName}`);
			console.log(`  ${pc.dim("Project:")}   ${projectPath}`);
			console.log(`  ${pc.dim("Language:")}  ${language}`);
			console.log(`  ${pc.dim("Snippet:")}   ${relSnippet}`);
			console.log(`  ${pc.dim("Log file:")}  ${jsonlPath}`);
			console.log("");

			if (language === "typescript") {
				console.log(pc.dim("Add to your code:"));
				console.log(`  import { dbg } from '${importPath}';`);
				console.log(`  dbg.session('${sessionName}');`);
			} else {
				console.log(pc.dim("Add to your code:"));
				console.log(`  require_once __DIR__ . '/${relSnippet}';`);
				console.log(`  LlmLog::session('${sessionName}');`);
			}

			console.log("");
			console.log(pc.dim("Next steps:"));
			console.log(`  ${suggestCommand(TOOL_NAME, { replaceCommand: ["tail", "--session", sessionName] })}`);
			console.log(`  ${suggestCommand(TOOL_NAME, { replaceCommand: ["get", "--session", sessionName] })}`);
			console.log("");

			// --- Optionally start HTTP server ---
			if (opts.serve) {
				let actualPort: number;
				try {
					({ port: actualPort } = startServer(port));
				} catch (err) {
					console.error(`Failed to start HTTP server on port ${port}: ${(err as Error).message}`);
					process.exit(1);
				}
				console.log(pc.green(`HTTP server listening on port ${actualPort}`));
				console.log(pc.dim(`POST http://localhost:${actualPort}/log/${sessionName}`));
				console.log("");

				// Keep process alive
				await new Promise(() => {});
			}
		});
}
