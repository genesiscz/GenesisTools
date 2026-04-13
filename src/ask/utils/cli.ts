import { formatDuration as _formatDuration } from "@app/utils/format";
import { SafeJSON } from "@app/utils/json";
import type { Args, CLIOptions, OutputFormat } from "@ask/types";
import { Command } from "commander";

interface ValidationResult {
    valid: boolean;
    errors: string[];
}

interface OutputFormatResult {
    type: OutputFormat;
    filename?: string;
}

export function parseCLIArguments(): Args {
    const program = new Command()
        .name("ask")
        .description("Multi-provider LLM chat application")
        .option("-s, --sst <file>", "Transcribe audio file")
        .option("-m, --model <name>", "Model to use")
        .option("-p, --provider [name]", "Provider (omit value to choose interactively)")
        .option(
            "-f, --format <fmt>",
            "Output format (text/json/jsonl/markdown/clipboard) or models format (table/json)"
        )
        .option("-o, --output <file>", "Output file path (implies file output)")
        .option("--sort <order>", "Sort models by: price_input/input/price_output/output/name")
        .option("--filter-capabilities <caps>", "Filter models by capabilities (pipe-separated)")
        .option("-i, --interactive", "Start interactive chat mode")
        .option("--streaming", "Enable streaming responses", true)
        .option("--no-streaming", "Disable streaming responses")
        .option("-t, --temperature <n>", "Temperature (0.0-2.0)")
        .option("-k, --max-tokens <n>", "Maximum tokens")
        .option("--system-prompt <text>", "System prompt")
        .option("--no-context", "Skip auto-injection of .genesistoolscontext.json artifacts")
        .option("-v, --verbose", "Enable verbose logging")
        .option("--silent", "Silent mode")
        .option("--predict-cost", "Show cost prediction before sending")
        .option("--raw", "Output only the raw response content (no metadata, no cost)")
        .option("--cost", "Show cost breakdown (always shown in TTY, opt-in for piped output)")
        .option("-?, --help-full", "Show detailed help message")
        .option("-V, --version", "Show version information")
        .argument("[prompt...]", "Initial prompt")
        .allowUnknownOption(false)
        .parse();

    const options = program.opts();
    const args = program.args;

    const result: Args = {
        _: args,
        sst: options.sst,
        model: options.model,
        provider: typeof options.provider === "string" ? options.provider : undefined,
        format: options.format,
        output: options.output,
        sort: options.sort,
        filterCapabilities: options.filterCapabilities,
        interactive: options.interactive,
        streaming: options.streaming,
        systemPrompt: options.systemPrompt,
        temperature: options.temperature ? parseFloat(options.temperature) : undefined,
        maxTokens: options.maxTokens ? parseInt(options.maxTokens, 10) : undefined,
        verbose: options.verbose,
        silent: options.silent,
        predictCost: options.predictCost,
        raw: options.raw,
        cost: options.cost,
        help: options.helpFull,
        version: options.version,
        noContext: options.context === false,
    };

    return result;
}

export function showHelp(): void {
    console.log(`
ASK Tool - Multi-Router LLM Chat Application

Usage:
  tools ask [options] [message]
  tools ask models [options]

Arguments:
  <message>               Message to send (for non-interactive mode)

Commands:
  models, model           Display pricing and detailed information for all available providers and models

Options:
  -s, --sst <file>        Transcribe audio file
  -m, --model <model>     Specify model (e.g., gpt-4-turbo)
  -p, --provider <prov>   Specify provider (e.g., openai)
  -f, --format <format>   Output format (text/json/jsonl/markdown/clipboard) or models format (table/json)
  -o, --output <file>     Output file path (writes response to file)
  --sort <order>          Sort models by: price_input/input/price_output/output/name (default: price_input)
  --filter-capabilities   Filter models by capabilities (pipe-separated: "chat|vision|functions|reasoning")
  -i, --interactive       Start interactive chat mode (default: true)
  -t, --temperature <n>   Set temperature (0.0-2.0)
  -k, --maxTokens <n>     Set maximum tokens
  --systemPrompt <text>   Set system prompt
  --streaming             Enable streaming responses (default: true)
  --no-streaming          Disable streaming responses
  --raw                   Output only the raw response (no metadata, cost, or formatting)
  -v, --verbose            Enable verbose logging
  --silent                Silent mode
  -h, --help              Show this help message
  -V, --version           Show version information

Examples:
  # Interactive chat mode
  tools ask

  # Single question
  tools ask "What is the capital of France?"

  # With specific model
  tools ask --model gpt-4-turbo "Explain quantum computing"

  # Show pricing and model information
  tools ask models
  tools ask models --provider openai
  tools ask models --format json
  tools ask models --sort price_input
  tools ask models --sort output --filter-capabilities="vision|functions"

  # Use --format for chat output
  tools ask --format json "What is 2+2?"
  tools ask --format markdown "Explain quantum computing"

  # Transcribe audio
  tools ask --sst recording.mp3

  # Save output to file
  tools ask -o response.txt "Generate a story"
  tools ask --format markdown -o out.md "Explain quantum computing"

  # Copy to clipboard
  tools ask --format clipboard "Summarize this topic"

Interactive Chat Commands:
  /model                  Switch AI model
  /output <format>        Change output format
  /clear                  Clear conversation history
  /save                   Save current conversation
  /sst <file>             Transcribe audio file
  /help                   Show available commands
  /quit, /exit            Exit chat

Supported Providers:
  - OpenAI (OPENAI_API_KEY)
  - Anthropic (ANTHROPIC_API_KEY)
  - Google (GOOGLE_API_KEY)
  - Groq (GROQ_API_KEY)
  - OpenRouter (OPENROUTER_API_KEY)
  - xAI (X_AI_API_KEY)
  - Jina AI (JINA_AI_API_KEY)

Audio Transcription:
  - Supports MP3, WAV, M4A, AAC, OGG, FLAC, WebM, MP4
  - Automatic provider selection based on file size
  - Large file support with providers like AssemblyAI and Deepgram

Environment Variables:
  BRAVE_API_KEY           Enable web search functionality
  ASK_CONVERSATIONS_DIR   Directory for saving conversations (default: ./conversations)
`);
}

export function showVersion(): void {
    console.log("ASK Tool v1.0.0");
    console.log("Multi-provider LLM chat application for GenesisTools");
}

export function validateOptions(options: CLIOptions): ValidationResult {
    const errors: string[] = [];

    // Validate temperature
    if (options.temperature !== undefined) {
        const temp = parseFloat(options.temperature.toString());
        if (Number.isNaN(temp) || temp < 0 || temp > 2) {
            errors.push("Temperature must be a number between 0 and 2");
        }
    }

    // Validate maxTokens
    if (options.maxTokens !== undefined) {
        const tokens = parseInt(options.maxTokens.toString(), 10);
        if (Number.isNaN(tokens) || tokens < 1 || tokens > 100000) {
            errors.push("Max tokens must be a number between 1 and 100000");
        }
    }

    // Validate format
    if (options.format) {
        const validFormats = ["text", "json", "jsonl", "markdown", "clipboard", "table"];
        const format = options.format.toLowerCase();

        if (!validFormats.includes(format)) {
            errors.push(`Invalid format: ${format}. Valid formats: ${validFormats.join(", ")}`);
        }
    }

    // Check for conflicting options
    if (options.sst && (options as Args)._?.length && (options as Args)._?.length > 0) {
        errors.push("Cannot use --sst and provide a message simultaneously");
    }

    if (options.help && options.version) {
        errors.push("Cannot use both --help and --version");
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

export function formatError(error: unknown, context?: string): string {
    let message = "";

    if (context) {
        message += `${context}: `;
    }

    if (error instanceof Error) {
        message += error.message;
    } else if (typeof error === "string") {
        message += error;
    } else {
        message += SafeJSON.stringify(error);
    }

    return message;
}

export function isInteractiveMode(options: CLIOptions, args: Args): boolean {
    // If explicitly set
    if (options.interactive !== undefined) {
        return options.interactive;
    }

    // If no message provided, assume interactive
    if (args._.length === 0 && !options.sst) {
        return true;
    }

    // If message provided, assume non-interactive
    return false;
}

export function shouldShowHelp(options: CLIOptions): boolean {
    return !!options.help;
}

export function shouldShowVersion(options: CLIOptions): boolean {
    return !!options.version;
}

/**
 * Get output config from -o (file path) and -f (format).
 *  -o <file>              → file output
 *  -f json                → json to stdout
 *  -f markdown -o out.md  → markdown written to file
 */
export function getOutputFormat(options: CLIOptions): OutputFormatResult | undefined {
    // -o implies file output
    if (options.output) {
        return { type: "file", filename: options.output };
    }

    // -f sets format (skip pricing-specific "table")
    if (options.format) {
        const format = options.format.toLowerCase();
        const validOutputFormats = ["text", "json", "jsonl", "markdown", "clipboard"];

        if (validOutputFormats.includes(format)) {
            return { type: format as OutputFormat };
        }
    }

    return undefined;
}

export function createSystemPrompt(customPrompt?: string): string | undefined {
    if (!customPrompt) {
        return undefined;
    }

    // Validate system prompt length
    if (customPrompt.length > 10000) {
        throw new Error("System prompt too long (max 10000 characters)");
    }

    return customPrompt.trim();
}

export function parseTemperature(tempArg?: string | number): number | undefined {
    if (tempArg === undefined) {
        return undefined;
    }

    const temp = typeof tempArg === "string" ? parseFloat(tempArg) : tempArg;

    if (Number.isNaN(temp) || temp < 0 || temp > 2) {
        throw new Error("Temperature must be a number between 0 and 2");
    }

    return temp;
}

export function parseMaxTokens(tokensArg?: string | number): number | undefined {
    if (tokensArg === undefined) {
        return undefined;
    }

    const tokens = typeof tokensArg === "string" ? parseInt(tokensArg, 10) : tokensArg;

    if (Number.isNaN(tokens) || tokens < 1 || tokens > 100000) {
        throw new Error("Max tokens must be a number between 1 and 100000");
    }

    return tokens;
}

export function getConversationsDir(): string {
    const customDir = process.env.ASK_CONVERSATIONS_DIR;
    return customDir || "./conversations";
}

export function formatElapsedTime(milliseconds: number): string {
    return _formatDuration(milliseconds, "ms", "hms");
}

export { formatBytes } from "@app/utils/format";

export function sanitizeFilename(filename: string): string {
    // Remove invalid characters and ensure it's a valid filename
    return filename
        .replace(/[<>:"/\\|?*]/g, "_") // Replace invalid chars with underscore
        .replace(/\s+/g, "_") // Replace spaces with underscores
        .substring(0, 100); // Limit length
}

export function generateTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}
