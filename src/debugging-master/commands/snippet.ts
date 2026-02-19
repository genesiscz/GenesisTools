import { Command } from "commander";
import { resolve } from "node:path";
import { ConfigManager } from "@app/debugging-master/core/config-manager";

const SNIPPET_TYPES = [
	"dump",
	"info",
	"warn",
	"error",
	"timer",
	"checkpoint",
	"assert",
	"snapshot",
	"trace",
] as const;

type SnippetType = (typeof SNIPPET_TYPES)[number];

const DEFAULT_PORT = 7243;

function tsImportSnippet(type: SnippetType, label: string): string {
	if (type === "timer") {
		return [
			"// #region @dbg",
			`dbg.timerStart('${label}');`,
			`// ... code to measure ...`,
			`dbg.timerEnd('${label}');`,
			"// #endregion @dbg",
		].join("\n");
	}

	const dataArg = type === "assert" ? `'${label}', condition` : `'${label}', data`;
	return [
		"// #region @dbg",
		`dbg.${type}(${dataArg});`,
		"// #endregion @dbg",
	].join("\n");
}

function phpImportSnippet(type: SnippetType, label: string): string {
	const cls = "LlmLog";

	if (type === "timer") {
		return [
			"// #region @dbg",
			`${cls}::timerStart('${label}');`,
			`// ... code to measure ...`,
			`${cls}::timerEnd('${label}');`,
			"// #endregion @dbg",
		].join("\n");
	}

	const dataArg = type === "assert" ? `'${label}', $condition` : `'${label}', $data`;
	return [
		"// #region @dbg",
		`${cls}::${type}(${dataArg});`,
		"// #endregion @dbg",
	].join("\n");
}

function tsHttpSnippet(type: SnippetType, label: string, session: string): string {
	const url = `http://127.0.0.1:${DEFAULT_PORT}/log/${session}`;

	if (type === "timer") {
		return [
			"// #region @dbg",
			`fetch('${url}', {`,
			`  method: 'POST',`,
			`  headers: {'Content-Type': 'application/json'},`,
			`  body: JSON.stringify({level: 'timer-start', label: '${label}'})`,
			`});`,
			`// ... code to measure ...`,
			`fetch('${url}', {`,
			`  method: 'POST',`,
			`  headers: {'Content-Type': 'application/json'},`,
			`  body: JSON.stringify({level: 'timer-end', label: '${label}'})`,
			`});`,
			"// #endregion @dbg",
		].join("\n");
	}

	const level = type;
	return [
		"// #region @dbg",
		`fetch('${url}', {`,
		`  method: 'POST',`,
		`  headers: {'Content-Type': 'application/json'},`,
		`  body: JSON.stringify({level: '${level}', label: '${label}', data})`,
		`});`,
		"// #endregion @dbg",
	].join("\n");
}

function phpHttpGuzzleSnippet(type: SnippetType, label: string, session: string): string {
	const url = `http://127.0.0.1:${DEFAULT_PORT}/log/${session}`;

	if (type === "timer") {
		return [
			"// #region @dbg",
			`(new \\GuzzleHttp\\Client())->post('${url}', [`,
			`  'json' => ['level' => 'timer-start', 'label' => '${label}']`,
			`]);`,
			`// ... code to measure ...`,
			`(new \\GuzzleHttp\\Client())->post('${url}', [`,
			`  'json' => ['level' => 'timer-end', 'label' => '${label}']`,
			`]);`,
			"// #endregion @dbg",
		].join("\n");
	}

	return [
		"// #region @dbg",
		`(new \\GuzzleHttp\\Client())->post('${url}', [`,
		`  'json' => ['level' => '${type}', 'label' => '${label}', 'data' => $data]`,
		`]);`,
		"// #endregion @dbg",
	].join("\n");
}

function phpHttpNativeSnippet(type: SnippetType, label: string, session: string): string {
	const url = `http://127.0.0.1:${DEFAULT_PORT}/log/${session}`;

	if (type === "timer") {
		return [
			"// #region @dbg",
			`file_get_contents('${url}', false, stream_context_create([`,
			`  'http' => ['method' => 'POST', 'header' => 'Content-Type: application/json',`,
			`    'content' => json_encode(['level' => 'timer-start', 'label' => '${label}'])]`,
			`]));`,
			`// ... code to measure ...`,
			`file_get_contents('${url}', false, stream_context_create([`,
			`  'http' => ['method' => 'POST', 'header' => 'Content-Type: application/json',`,
			`    'content' => json_encode(['level' => 'timer-end', 'label' => '${label}'])]`,
			`]));`,
			"// #endregion @dbg",
		].join("\n");
	}

	return [
		"// #region @dbg",
		`file_get_contents('${url}', false, stream_context_create([`,
		`  'http' => ['method' => 'POST', 'header' => 'Content-Type: application/json',`,
		`    'content' => json_encode(['level' => '${type}', 'label' => '${label}', 'data' => $data])]`,
		`]));`,
		"// #endregion @dbg",
	].join("\n");
}

async function hasGuzzle(cwd: string): Promise<boolean> {
	try {
		const composerPath = resolve(cwd, "composer.json");
		const file = Bun.file(composerPath);
		if (!(await file.exists())) return false;
		const content = await file.json();
		const deps = { ...content.require, ...content["require-dev"] };
		return "guzzlehttp/guzzle" in deps;
	} catch {
		return false;
	}
}

export function registerSnippetCommand(program: Command): void {
	program
		.command("snippet")
		.description("Generate instrumentation code snippet with @dbg region markers")
		.argument("<type>", `Snippet type: ${SNIPPET_TYPES.join(", ")}`)
		.argument("<label>", "Label or message string for the log call")
		.option("--language <lang>", "Override language (typescript|php)")
		.option("--http", "Generate fetch/HTTP-based snippet instead of import-based")
		.action(async (type: string, label: string, opts: { language?: string; http?: boolean }) => {
			if (!SNIPPET_TYPES.includes(type as SnippetType)) {
				console.error(`Unknown snippet type: ${type}`);
				console.error(`Valid types: ${SNIPPET_TYPES.join(", ")}`);
				process.exit(1);
			}

			const snippetType = type as SnippetType;
			const configManager = new ConfigManager();

			let language: "typescript" | "php" = "typescript";
			if (opts.language) {
				if (opts.language !== "typescript" && opts.language !== "php") {
					console.error(`Unsupported language: ${opts.language}. Use typescript or php.`);
					process.exit(1);
				}
				language = opts.language;
			} else {
				const cwd = process.cwd();
				const project = await configManager.getProject(cwd);
				if (project) {
					language = project.language;
				}
			}

			if (opts.http) {
				const session = (await configManager.getRecentSession()) ?? "default";

				if (language === "typescript") {
					console.log(tsHttpSnippet(snippetType, label, session));
				} else {
					const guzzle = await hasGuzzle(process.cwd());
					if (guzzle) {
						console.log(phpHttpGuzzleSnippet(snippetType, label, session));
					} else {
						console.log(phpHttpNativeSnippet(snippetType, label, session));
					}
				}
			} else {
				if (language === "typescript") {
					console.log(tsImportSnippet(snippetType, label));
				} else {
					console.log(phpImportSnippet(snippetType, label));
				}
			}
		});
}
