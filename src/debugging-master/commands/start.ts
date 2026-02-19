import type { Command } from "commander";
import { existsSync, copyFileSync } from "node:fs";
import { resolve, join, relative, basename } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { ConfigManager } from "@app/debugging-master/core/config-manager";
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

			// --- Resolve session name ---
			let sessionName = globalOpts.session;

			if (!sessionName) {
				if (!process.stdout.isTTY) {
					console.error(
						`Error: --session <name> is required in non-interactive mode.\n` +
						`  ${suggestCommand(TOOL_NAME, { add: ["start", "--session", "<name>"] })}`,
					);
					process.exit(1);
				}

				p.intro(pc.bold("debugging-master start"));

				const nameResult = await p.text({
					message: "Session name",
					placeholder: basename(projectPath),
					validate: (v) => {
						if (!v.trim()) return "Session name is required";
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
				console.log(`  dbg_session('${sessionName}');`);
			}

			console.log("");
			console.log(pc.dim("Next steps:"));
			console.log(`  ${suggestCommand(TOOL_NAME, { add: ["tail", "--session", sessionName] })}`);
			console.log(`  ${suggestCommand(TOOL_NAME, { add: ["show", "--session", sessionName] })}`);
			console.log("");

			// --- Optionally start HTTP server ---
			if (opts.serve) {
				const { port: actualPort } = startServer(port);
				console.log(pc.green(`HTTP server listening on port ${actualPort}`));
				console.log(pc.dim(`POST http://localhost:${actualPort}/log/${sessionName}`));
				console.log("");

				// Keep process alive
				await new Promise(() => {});
			}
		});
}
