import { Command, Option } from "commander";
import { formatSchema, type OutputMode } from "@app/utils/json-schema";
import clipboardy from "clipboardy";

interface Options {
	mode: OutputMode;
	pretty?: boolean;
	clipboard?: boolean;
}

async function readInput(filePath?: string): Promise<string> {
	if (filePath) {
		return Bun.file(filePath).text();
	}
	// Read from stdin
	const chunks: Uint8Array[] = [];
	const reader = Bun.stdin.stream().getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

const program = new Command();

program
	.name("json-schema")
	.description("Infer schema from JSON data. Reads from file or stdin.")
	.argument("[file]", "JSON file to analyze")
	.addOption(new Option("-m, --mode <mode>", "Output mode").choices(["schema", "skeleton", "typescript"]).default("skeleton"))
	.option("-p, --pretty", "Multi-line indented output (default: compact one-line)")
	.option("-c, --clipboard", "Copy output to clipboard")
	.action(async (file: string | undefined, options: Options) => {
		const raw = await readInput(file);

		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			console.error("Failed to parse JSON input.");
			process.exit(1);
		}

		const output = formatSchema(value, options.mode, { pretty: options.pretty });

		if (options.clipboard) {
			await clipboardy.write(output);
			console.error(`Schema copied to clipboard (${options.mode} mode)`);
		} else {
			console.log(output);
		}
	});

program.parse();
