export interface TimelyArgs {
    _: string[]; // Positional arguments (command, subcommand)
    help?: boolean;
    verbose?: boolean;
    format?: "json" | "table" | "csv" | "raw" | "summary" | "detailed-summary";
    silent?: boolean;
    quiet?: boolean;

    // Account/project overrides
    account?: number;
    project?: number;

    // Date filters
    since?: string; // YYYY-MM-DD
    upto?: string; // YYYY-MM-DD
    day?: string; // YYYY-MM-DD
    month?: string; // YYYY-MM

    // Interactive flags
    select?: boolean; // For accounts/projects commands

    // Output control
    output?: string; // Output file path
    clipboard?: boolean; // Copy to clipboard
}
