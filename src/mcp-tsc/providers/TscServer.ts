import ts from "typescript";
import path from "path";
import type {
    TSServer,
    DiagnosticsResult,
    DiagnosticsOptions,
    HoverResult,
    HoverPosition,
    TsDiagnostic,
} from "../core/interfaces.js";

export interface TscServerOptions {
    cwd: string;
}

/**
 * TypeScript diagnostics provider using the TypeScript Compiler API.
 * Provides full type-checking but slower for incremental checks.
 * Does not maintain persistent state.
 */
export class TscServer implements TSServer {
    private cwd: string;

    constructor(options: TscServerOptions) {
        this.cwd = options.cwd;
    }

    async initialize(): Promise<void> {
        // No initialization needed for Compiler API
    }

    async getDiagnostics(files: string[], options?: DiagnosticsOptions): Promise<DiagnosticsResult> {
        const showWarnings = options?.showWarnings ?? false;

        // Find tsconfig.json
        const configPath = ts.findConfigFile(this.cwd, ts.sys.fileExists, "tsconfig.json");
        if (!configPath) {
            throw new Error("tsconfig.json not found");
        }

        // Parse tsconfig
        const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));

        // Create TypeScript program
        const program = ts.createProgram({
            rootNames: parsed.fileNames,
            options: parsed.options,
        });

        // Collect diagnostics for target files
        const targetDiagnostics: ts.Diagnostic[] = [];

        for (const file of files) {
            const sourceFile = program.getSourceFile(file);
            if (sourceFile) {
                const syntacticDiagnostics = program.getSyntacticDiagnostics(sourceFile);
                const semanticDiagnostics = program.getSemanticDiagnostics(sourceFile);
                targetDiagnostics.push(...syntacticDiagnostics, ...semanticDiagnostics);
            }
        }

        // Sort diagnostics by file and position
        targetDiagnostics.sort((a, b) => {
            if (!a.file || !b.file) return 0;
            if (a.file.fileName !== b.file.fileName) {
                return a.file.fileName.localeCompare(b.file.fileName);
            }
            return (a.start ?? 0) - (b.start ?? 0);
        });

        // Transform to common format
        let errors = 0;
        let warnings = 0;
        const diagnostics: TsDiagnostic[] = [];

        for (const d of targetDiagnostics) {
            const file = d.file?.fileName ?? "";
            const { line, character } =
                d.file && d.start != null
                    ? ts.getLineAndCharacterOfPosition(d.file, d.start)
                    : { line: 0, character: 0 };
            const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");

            const diagnostic: TsDiagnostic = {
                file,
                line: line + 1, // Convert to 1-based
                character: character + 1, // Convert to 1-based
                severity: d.category === ts.DiagnosticCategory.Error ? 1 : 2,
                code: d.code,
                message: msg,
            };

            diagnostics.push(diagnostic);

            if (d.category === ts.DiagnosticCategory.Error) {
                errors++;
            } else if (d.category === ts.DiagnosticCategory.Warning) {
                warnings++;
            }
        }

        return { errors, warnings, diagnostics };
    }

    async getHover(file: string, position: HoverPosition): Promise<HoverResult> {
        // Hover is not efficiently implemented with Compiler API alone
        // Would need to create a LanguageService which is complex
        // For now, we recommend using LspServer for hover functionality
        throw new Error("Hover not supported with --use-tsc. Use LSP mode (default) for hover functionality.");
    }

    formatDiagnostics(result: DiagnosticsResult, showWarnings: boolean): string[] {
        const lines: string[] = [];

        for (const d of result.diagnostics) {
            // Skip info/hint diagnostics (severity > 2)
            if (d.severity > 2) continue;

            // Skip warnings unless requested
            if (d.severity === 2 && !showWarnings) continue;

            const relativeFile = path.relative(this.cwd, d.file) || d.file;
            const severityText = d.severity === 1 ? "error" : "warning";
            lines.push(`${relativeFile}:${d.line}:${d.character} - ${severityText} TS${d.code}: ${d.message}`);
        }

        return lines;
    }

    async shutdown(): Promise<void> {
        // No cleanup needed for Compiler API
    }
}
