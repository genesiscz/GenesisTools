#!/usr/bin/env bun
/**
 * React Compiler Debug Tool
 *
 * Inspect what babel-plugin-react-compiler generates from React components.
 *
 * Usage:
 *   tools react-compiler-debug <file.tsx>
 *   tools react-compiler-debug --code "const Foo = () => <div />"
 *   echo "code" | tools react-compiler-debug --stdin
 */

import { Command } from "commander";
import * as babel from "@babel/core";
import chalk from "chalk";
import clipboardy from "clipboardy";
import { resolve } from "path";
import logger from "@app/logger";

interface CompilerOptions {
	target: "17" | "18" | "19";
	compilationMode?: "infer" | "all" | "annotation" | "syntax";
	panicThreshold?: "none" | "critical_errors" | "all_errors";
	logger?: {
		logEvent: (filename: string | null, event: unknown) => void;
	};
}

interface ProgramOptions {
	code?: string;
	stdin?: boolean;
	verbose?: boolean;
	clipboard?: boolean;
	target?: "17" | "18" | "19";
	mode?: "infer" | "all" | "annotation" | "syntax";
	onlyCompiled?: boolean;
}

const program = new Command();

program
	.name("react-compiler-debug")
	.description("Inspect React Compiler output for components")
	.argument("[file]", "File to compile")
	.option("-c, --code <code>", "Compile inline code snippet")
	.option("-s, --stdin", "Read code from stdin")
	.option("-v, --verbose", "Show compiler events")
	.option("--clipboard", "Copy output to clipboard")
	.option("-t, --target <version>", "React version target (17, 18, 19)", "19")
	.option("-m, --mode <mode>", "Compilation mode (infer, all, annotation, syntax)", "infer")
	.option("--only-compiled", "Only show compiled output, not original")
	.action(async (fileArg: string | undefined, options: ProgramOptions) => {
		try {
			await main(fileArg, options);
		} catch (error) {
			if (error instanceof Error) {
				console.error(chalk.red("Error:"), error.message);
				if (options.verbose) {
					console.error(error.stack);
				}
			}
			process.exit(1);
		}
	});

function createCompilerOptions(options: ProgramOptions): CompilerOptions {
	const compilerOptions: CompilerOptions = {
		target: (options.target as "17" | "18" | "19") || "19",
		compilationMode: options.mode || "infer",
	};

	if (options.verbose) {
		compilerOptions.logger = {
			logEvent(filename: string | null, event: unknown) {
				console.error(
					chalk.dim("[Compiler Event]"),
					chalk.cyan(filename || "unknown"),
					JSON.stringify(event, null, 2)
				);
			},
		};
	}

	return compilerOptions;
}

async function compileCode(
	code: string,
	filename: string,
	compilerOptions: CompilerOptions
): Promise<string> {
	const result = await babel.transformAsync(code, {
		filename,
		presets: [
			["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
		],
		plugins: [
			["babel-plugin-react-compiler", compilerOptions],
		],
		parserOpts: {
			plugins: ["jsx", "typescript"],
		},
	});

	if (!result?.code) {
		throw new Error("Compilation failed - no output generated");
	}

	return result.code;
}

async function main(fileArg: string | undefined, options: ProgramOptions) {
	let code: string;
	let filename: string;

	// Get input from various sources
	if (options.code) {
		code = options.code;
		filename = "inline.tsx";
	} else if (options.stdin) {
		code = await Bun.stdin.text();
		filename = "stdin.tsx";
	} else if (fileArg) {
		const filePath = resolve(fileArg);
		const file = Bun.file(filePath);
		if (!(await file.exists())) {
			throw new Error(`File not found: ${fileArg}`);
		}
		code = await file.text();
		filename = filePath;
	} else {
		console.error(chalk.red("No input provided."));
		console.log("\nUsage:");
		console.log("  tools react-compiler-debug <file.tsx>");
		console.log('  tools react-compiler-debug --code "const Foo = () => <div />"');
		console.log("  cat file.tsx | tools react-compiler-debug --stdin");
		process.exit(1);
	}

	const compilerOptions = createCompilerOptions(options);

	logger.info({
		component: "react-compiler-debug",
		filename,
		target: compilerOptions.target,
		mode: compilerOptions.compilationMode,
	}, "Compiling");

	// Build output
	const output: string[] = [];

	if (!options.onlyCompiled) {
		output.push(chalk.bold.blue("// ====== ORIGINAL ======"));
		output.push(code);
		output.push("");
	}

	output.push(chalk.bold.green("// ====== COMPILED ======"));

	try {
		const compiled = await compileCode(code, filename, compilerOptions);
		output.push(compiled);

		// Add summary - detect both useMemoCache and _c (runtime import)
		const hasCompilerRuntime = compiled.includes("react/compiler-runtime") || compiled.includes("useMemoCache");
		const cacheSlots = (compiled.match(/\$\[\d+\]/g) || []).length;

		output.push("");
		output.push(chalk.dim("// ====== SUMMARY ======"));
		output.push(chalk.dim(`// Memoized: ${hasCompilerRuntime ? chalk.green("Yes") : chalk.yellow("No")}`));
		if (hasCompilerRuntime && cacheSlots > 0) {
			output.push(chalk.dim(`// Cache slots used: ${cacheSlots}`));
		}
	} catch (error) {
		output.push(chalk.red(`Compilation error: ${error instanceof Error ? error.message : String(error)}`));
		if (options.verbose && error instanceof Error) {
			output.push(chalk.dim(error.stack || ""));
		}
	}

	const outputText = output.join("\n");

	// Handle output destination
	if (options.clipboard) {
		// Strip ANSI codes for clipboard
		const plainText = outputText.replace(/\x1B\[[0-9;]*m/g, "");
		await clipboardy.write(plainText);
		console.log(chalk.green("Output copied to clipboard!"));
		console.log(outputText);
	} else {
		console.log(outputText);
	}
}

program.parse();
