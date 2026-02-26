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

import { handleReadmeFlag } from "@app/utils/readme";
import * as babel from "@babel/core";
import generate from "@babel/generator";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import chalk from "chalk";
import { Command } from "commander";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import logger from "@app/logger";
import { copyToClipboard } from "@app/utils/clipboard";

// Resolve babel-plugin-react-compiler from GenesisTools installation
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const genesisToolsRoot = resolve(__dirname, "../..");

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
    withOriginal?: boolean;
    raw?: boolean;
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
    .option("--with-original", "Include original code before compiled output")
    .option("--raw", "Output raw compiler output without prettification")
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

async function compileCode(code: string, filename: string, compilerOptions: CompilerOptions): Promise<string> {
    // Resolve plugin from GenesisTools node_modules for consistent behavior
    const reactCompilerPlugin = resolve(genesisToolsRoot, "node_modules/babel-plugin-react-compiler");

    const result = await babel.transformAsync(code, {
        filename,
        // Disable automatic config file loading - we want to isolate the React Compiler
        // transformation only, not run full project transforms (module-resolver, worklets, etc.)
        // which can cause errors outside the project's build context
        configFile: false,
        babelrc: false,
        presets: [["@babel/preset-typescript", { isTSX: true, allExtensions: true }]],
        plugins: [[reactCompilerPlugin, compilerOptions]],
        parserOpts: {
            plugins: ["jsx", "typescript"],
        },
    });

    if (!result?.code) {
        throw new Error("Compilation failed - no output generated");
    }

    return result.code;
}

/**
 * Prettify the React Compiler output for human readability.
 *
 * Transformations:
 * 1. Rename t0 → props in component arrow functions
 * 2. Inline temp variables (let tN → const NAME = tN) into their final names
 * 3. Add comments for sentinel checks (first render)
 * 4. Annotate cache slots with what they store
 */
function prettifyCompiledCode(code: string): string {
    const ast = parse(code, {
        sourceType: "module",
        plugins: ["jsx", "typescript"],
    });

    // Track temp var → final name mappings
    const tempToFinalName = new Map<string, string>();
    // Track cache slot contents: slot index → variable name
    const cacheSlotContents = new Map<number, string>();
    // Track which temp vars are used in cache patterns
    const tempVarsInCachePattern = new Set<string>();
    // Track component scopes where t0 should be renamed to props
    const componentScopes = new Set<babel.NodePath>();

    // First pass: identify temp var → final name mappings and cache patterns
    traverse(ast, {
        // Find component arrow functions and mark t0 → props
        ArrowFunctionExpression(path) {
            const parent = path.parent;
            // Check if this is a component (assigned to a const with PascalCase name)
            if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id) && /^[A-Z]/.test(parent.id.name)) {
                const params = path.node.params;
                if (params.length === 1 && t.isIdentifier(params[0]) && params[0].name === "t0") {
                    componentScopes.add(path);
                    tempToFinalName.set("t0", "props");
                }
            }
        },

        // Find patterns like: const NAME = tN;
        VariableDeclaration(path) {
            if (path.node.kind !== "const") {
                return;
            }

            for (const decl of path.node.declarations) {
                if (t.isIdentifier(decl.id) && t.isIdentifier(decl.init) && /^t\d+$/.test(decl.init.name)) {
                    const tempName = decl.init.name;
                    const finalName = decl.id.name;
                    tempToFinalName.set(tempName, finalName);
                }
            }
        },

        // Find cache slot assignments: $[N] = value
        AssignmentExpression(path) {
            const { left, right } = path.node;
            if (
                t.isMemberExpression(left) &&
                t.isIdentifier(left.object, { name: "$" }) &&
                t.isNumericLiteral(left.property)
            ) {
                const slotIndex = left.property.value;
                if (t.isIdentifier(right)) {
                    const varName = right.name;
                    // Store the raw var name, we'll resolve to final name later
                    cacheSlotContents.set(slotIndex, varName);
                    if (/^t\d+$/.test(varName)) {
                        tempVarsInCachePattern.add(varName);
                    }
                }
            }
        },
    });

    // Resolve cache slot contents to final names
    for (const [slotIndex, varName] of cacheSlotContents.entries()) {
        const finalName = tempToFinalName.get(varName) || varName;
        cacheSlotContents.set(slotIndex, finalName);
    }

    // Second pass: apply transformations
    traverse(ast, {
        // Rename t0 → props in component arrow function params
        ArrowFunctionExpression(path) {
            if (componentScopes.has(path)) {
                const params = path.node.params;
                if (params.length === 1 && t.isIdentifier(params[0]) && params[0].name === "t0") {
                    params[0].name = "props";
                }
            }
        },

        // Rename temp variables in let declarations
        VariableDeclaration(path) {
            if (path.node.kind === "let") {
                for (const decl of path.node.declarations) {
                    if (t.isIdentifier(decl.id) && /^t\d+$/.test(decl.id.name)) {
                        const tempName = decl.id.name;
                        const finalName = tempToFinalName.get(tempName);
                        if (finalName) {
                            // Rename the declaration
                            decl.id.name = finalName;
                            // Add comment only if this is a memoized var (in cache pattern)
                            if (tempVarsInCachePattern.has(tempName)) {
                                if (!path.node.trailingComments) {
                                    path.node.trailingComments = [];
                                }
                                path.node.trailingComments.push({
                                    type: "CommentLine",
                                    value: " 📦 memoized",
                                } as t.CommentLine);
                            }
                        }
                    }
                }
            }

            // Remove the `const NAME = tN;` statements (they're now inlined)
            if (path.node.kind === "const") {
                const declarations = path.node.declarations.filter((decl) => {
                    if (
                        t.isIdentifier(decl.id) &&
                        t.isIdentifier(decl.init) &&
                        /^t\d+$/.test(decl.init.name) &&
                        tempToFinalName.has(decl.init.name)
                    ) {
                        return false; // Remove this declaration
                    }
                    return true;
                });

                if (declarations.length === 0) {
                    path.remove();
                } else if (declarations.length !== path.node.declarations.length) {
                    path.node.declarations = declarations;
                }
            }
        },

        // Rename all temp var usages (including t0 → props)
        Identifier(path) {
            const node = path.node;
            const name = node.name;

            // Skip variable declarations (we handle them separately in VariableDeclaration)
            // But allow assignment targets (left side of = in AssignmentExpression)
            const parent = path.parent;
            if (t.isVariableDeclarator(parent) && parent.id === node) {
                return; // This is a variable declaration, skip
            }

            // Handle t0 → props in component scopes
            if (name === "t0") {
                // Check if we're inside a component scope
                let currentPath: babel.NodePath | null = path.parentPath;
                while (currentPath) {
                    if (componentScopes.has(currentPath)) {
                        node.name = "props";
                        return;
                    }
                    currentPath = currentPath.parentPath;
                }
            }

            // Handle all temp vars that have a final name mapping
            if (/^t\d+$/.test(name) && tempToFinalName.has(name)) {
                const finalName = tempToFinalName.get(name);
                if (finalName) {
                    node.name = finalName;
                }
            }
        },

        // Add comment to sentinel checks
        IfStatement(path) {
            const test = path.node.test;
            // Match: $[N] === Symbol.for("react.memo_cache_sentinel")
            if (
                t.isBinaryExpression(test, { operator: "===" }) &&
                t.isMemberExpression(test.left) &&
                t.isIdentifier(test.left.object, { name: "$" }) &&
                t.isCallExpression(test.right) &&
                t.isMemberExpression(test.right.callee) &&
                t.isIdentifier(test.right.callee.object, { name: "Symbol" }) &&
                t.isIdentifier(test.right.callee.property, { name: "for" })
            ) {
                // Add comment to the if statement's test
                if (!test.trailingComments) {
                    test.trailingComments = [];
                }
                test.trailingComments.push({
                    type: "CommentLine",
                    value: " first render",
                } as t.CommentLine);
            }
        },

        // Annotate the cache initialization: const $ = _c(N);
        CallExpression(path) {
            if (
                t.isIdentifier(path.node.callee, { name: "_c" }) &&
                path.node.arguments.length === 1 &&
                t.isNumericLiteral(path.node.arguments[0])
            ) {
                // Build cache slot annotation
                if (cacheSlotContents.size > 0) {
                    const slots = Array.from(cacheSlotContents.entries())
                        .sort((a, b) => a[0] - b[0])
                        .slice(0, 5) // Limit to first 5 slots
                        .map(([idx, name]) => `${idx}=${name}`)
                        .join(", ");

                    const suffix = cacheSlotContents.size > 5 ? ", ..." : "";

                    const parent = path.parentPath;
                    if (parent && t.isVariableDeclarator(parent.node)) {
                        const declPath = parent.parentPath;
                        if (declPath && t.isVariableDeclaration(declPath.node)) {
                            if (!declPath.node.trailingComments) {
                                declPath.node.trailingComments = [];
                            }
                            declPath.node.trailingComments.push({
                                type: "CommentLine",
                                value: ` cache: [${slots}${suffix}]`,
                            } as t.CommentLine);
                        }
                    }
                }
            }
        },
    });

    const output = generate(ast, {
        comments: true,
        compact: false,
    });

    return output.code;
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

    logger.info(
        {
            component: "react-compiler-debug",
            filename,
            target: compilerOptions.target,
            mode: compilerOptions.compilationMode,
        },
        "Compiling"
    );

    // Build output
    const output: string[] = [];

    if (options.withOriginal && !options.code) {
        output.push(chalk.bold.blue("// ====== ORIGINAL ======"));
        output.push(code);
        output.push("");
    }

    output.push(chalk.bold.green("// ====== COMPILED ======"));

    try {
        let compiled = await compileCode(code, filename, compilerOptions);

        // Apply prettification unless --raw is specified
        if (!options.raw) {
            try {
                compiled = prettifyCompiledCode(compiled);
            } catch (prettifyError) {
                // If prettification fails, fall back to raw output
                if (options.verbose) {
                    console.error(chalk.yellow("Prettification failed, using raw output:"), prettifyError);
                }
            }
        }

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
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (errorMessage.includes("Cannot find package")) {
            output.push(chalk.red("Dependency Error: babel-plugin-react-compiler not found."));
            output.push("");
            output.push(chalk.yellow("This tool requires GenesisTools to be fully installed."));
            output.push(chalk.dim("Run: /genesis-tools:setup to install the full toolkit."));
        } else {
            output.push(chalk.red(`Compilation error: ${errorMessage}`));
        }

        if (options.verbose && error instanceof Error) {
            output.push(chalk.dim(error.stack || ""));
        }
    }

    const outputText = output.join("\n");

    // Handle output destination
    if (options.clipboard) {
        // Strip ANSI codes for clipboard
        // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape/control character matching
        const plainText = outputText.replace(/\x1B\[[0-9;]*m/g, "");
        await copyToClipboard(plainText, { silent: true });
        console.log(chalk.green("Output copied to clipboard!"));
        console.log(outputText);
    } else {
        console.log(outputText);
    }
}

program.parse();
