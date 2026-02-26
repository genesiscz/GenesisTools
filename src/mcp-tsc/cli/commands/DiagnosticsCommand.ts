import type { CliArgs, DiagnosticsResult, TSServer } from "@app/mcp-tsc/core/interfaces.js";
import { filterByTsconfig, resolveFiles } from "@app/mcp-tsc/utils/FileResolver.js";

export class DiagnosticsCommand {
    constructor(
        private tsServer: TSServer,
        private cwd: string,
    ) {}

    async execute(argv: CliArgs): Promise<void> {
        const files = argv._;

        if (files.length === 0) {
            console.error("Error: No files specified for diagnostics");
            process.exit(1);
        }

        // Resolve and filter files
        const targetFiles = await resolveFiles(files, this.cwd);
        if (targetFiles.length === 0) {
            console.error("No files found matching the specified patterns");
            process.exit(1);
        }

        const filteredFiles = filterByTsconfig(targetFiles, this.cwd);
        if (filteredFiles.length === 0) {
            console.error("None of the matched files are included in tsconfig.json");
            console.error(`Matched ${targetFiles.length} file(s), but none are in the current TypeScript project`);
            process.exit(1);
        }

        if (filteredFiles.length < targetFiles.length) {
            console.log(`Note: ${targetFiles.length - filteredFiles.length} file(s) excluded (not in tsconfig.json)`);
        }

        console.log(`Checking ${filteredFiles.length} file(s)...`);

        // Initialize server if needed
        if (this.tsServer.initialize) {
            await this.tsServer.initialize();
        }

        // Get diagnostics
        const result: DiagnosticsResult = await this.tsServer.getDiagnostics(filteredFiles, {
            showWarnings: argv.warnings,
        });

        // Format and display diagnostics
        const formattedLines = this.tsServer.formatDiagnostics(result, argv.warnings);
        formattedLines.forEach((line) => {
            console.log(line);
        });

        // Summary
        console.log();
        if (result.errors === 0 && result.warnings === 0) {
            console.log("✓ No issues found");
        } else {
            if (result.errors > 0) {
                console.log(`✗ Found ${result.errors} error(s)`);
            }
            if (result.warnings > 0) {
                console.log(`⚠ Found ${result.warnings} warning(s)`);
            }
        }

        process.exit(result.errors > 0 ? 2 : 0);
    }
}
