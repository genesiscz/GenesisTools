import { logger, out } from "@app/logger";
import { modelSelector } from "@ask/providers/ModelSelector";
import type { OutputConfig, OutputFormat, ProviderChoice } from "@ask/types";
import { getLanguageModel } from "@ask/types";
import * as p from "@clack/prompts";
import type { LanguageModel } from "ai";
import pc from "picocolors";

export interface CommandResult {
    shouldExit?: boolean;
    newModel?: LanguageModel;
    newProvider?: string;
    newModelName?: string;
    newProviderChoice?: ProviderChoice;
    outputFormat?: OutputConfig;
    clearHistory?: boolean;
    saveConversation?: boolean;
    transcriptionFile?: string;
    showHelp?: boolean;
}

/** State exposed to introspection commands (/context, /tools, /history, /system). */
export interface ChatState {
    systemPrompt?: string;
    conversationLength: number;
    totalTokens: number;
    toolNames: string[];
    contextBlock?: string;
}

export class CommandHandler {
    async handleCommand(
        command: string,
        _currentProvider: string,
        _currentModelName: string,
        state?: ChatState
    ): Promise<CommandResult> {
        const parts = command.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);

        try {
            switch (cmd) {
                case "/model":
                    return await this.handleModelCommand();
                case "/output":
                    return await this.handleOutputCommand(args);
                case "/quit":
                case "/exit":
                    return { shouldExit: true };
                case "/clear":
                    return { clearHistory: true };
                case "/save":
                    return { saveConversation: true };
                case "/sst":
                    return await this.handleSSTCommand(args);
                case "/context":
                    this.handleContextCommand(state);
                    return {};
                case "/tools":
                    this.handleToolsCommand(state);
                    return {};
                case "/history":
                    this.handleHistoryCommand(state);
                    return {};
                case "/system":
                    this.handleSystemCommand(state);
                    return {};
                case "/help":
                    return { showHelp: true };
                default:
                    logger.error(`Unknown command: ${cmd}. Type /help for available commands.`);
                    return {};
            }
        } catch (error) {
            logger.error(`Error executing command ${cmd}: ${error}`);
            return {};
        }
    }

    private async handleModelCommand(): Promise<CommandResult> {
        p.log.info(pc.blue("Selecting new model..."));

        const newChoice = await modelSelector.selectModel();
        if (!newChoice) {
            return {};
        }

        p.log.success(`Switched to ${newChoice.provider.name}/${newChoice.model.name}`);

        const model = getLanguageModel(newChoice.provider.provider, newChoice.model.id, newChoice.provider.type);
        return {
            newModel: model,
            newProvider: newChoice.provider.name,
            newModelName: newChoice.model.id,
            newProviderChoice: newChoice,
        };
    }

    private async handleOutputCommand(args: string[]): Promise<CommandResult> {
        if (args.length === 0) {
            this.showOutputFormats();
            return {};
        }

        const format = args[0].toLowerCase();
        const validFormats: OutputFormat[] = ["text", "json", "markdown", "clipboard", "file"];

        if (format === "file" && args.length > 1) {
            const filename = args.slice(1).join(" ");
            return {
                outputFormat: { type: "file", filename },
            };
        }

        if (validFormats.includes(format as OutputFormat)) {
            return {
                outputFormat: { type: format as OutputFormat },
            };
        }

        logger.error(`Invalid output format: ${format}`);
        this.showOutputFormats();
        return {};
    }

    private showOutputFormats(): void {
        out.print(pc.cyan("\nAvailable output formats:"));
        out.print(pc.bold("  text        ") + pc.dim("Plain text output (default)"));
        out.print(pc.bold("  json        ") + pc.dim("Structured JSON responses"));
        out.print(pc.bold("  markdown    ") + pc.dim("Markdown formatted output"));
        out.print(pc.bold("  clipboard   ") + pc.dim("Auto-copy responses to clipboard"));
        out.print(pc.bold("  file <name> ") + pc.dim("Save responses to specified file"));
        out.print(pc.dim("\nUsage: /output <format>"));
        out.print(pc.dim("Example: /output file responses.txt"));
    }

    private async handleSSTCommand(args: string[]): Promise<CommandResult> {
        if (args.length === 0) {
            const file = await p.text({
                message: "Enter audio file path:",
                validate: (value) => {
                    if (!value?.trim()) {
                        return "Please enter a file path.";
                    }
                    return undefined;
                },
            });

            if (p.isCancel(file)) {
                return {};
            }
            return { transcriptionFile: file };
        }

        const filePath = args.join(" ");
        return { transcriptionFile: filePath };
    }

    private handleContextCommand(state?: ChatState): void {
        out.print(pc.cyan("\nLoaded Context:"));

        if (!state?.contextBlock) {
            out.print(pc.dim("  No context artifacts loaded."));
            out.print(pc.dim("  Add a .genesistoolscontext.json to your project root."));
        } else {
            const lines = state.contextBlock.split("\n");
            const preview = lines.slice(0, 15).join("\n");
            out.print(pc.dim(preview));

            if (lines.length > 15) {
                out.print(pc.dim(`  ... (${lines.length - 15} more lines)`));
            }
        }

        out.print();
    }

    private handleToolsCommand(state?: ChatState): void {
        out.print(pc.cyan("\nAvailable Tools:"));

        if (!state?.toolNames.length) {
            out.print(pc.dim("  No tools enabled. Use --no-tools to disable tools."));
        } else {
            for (const name of state.toolNames) {
                out.print(pc.bold(`  ${name}`));
            }
        }

        out.print();
    }

    private handleHistoryCommand(state?: ChatState): void {
        out.print(pc.cyan("\nConversation History:"));

        if (!state) {
            out.print(pc.dim("  No state available."));
        } else {
            out.print(`${pc.bold("  Messages: ")}${state.conversationLength}`);
            out.print(`${pc.bold("  Est. tokens: ")}${state.totalTokens.toLocaleString()}`);
        }

        out.print();
    }

    private handleSystemCommand(state?: ChatState): void {
        out.print(pc.cyan("\nSystem Prompt:"));

        if (!state?.systemPrompt) {
            out.print(pc.dim("  No system prompt set."));
        } else {
            const truncated =
                state.systemPrompt.length > 500
                    ? `${state.systemPrompt.slice(0, 500)}\n... (truncated)`
                    : state.systemPrompt;
            out.print(pc.dim(truncated));
        }

        out.print();
    }

    showHelp(): void {
        out.print(pc.cyan("\nAvailable Commands:"));
        out.print();

        out.print(pc.bold("  /model") + pc.dim("              Switch to a different AI model"));
        out.print(pc.dim("    Opens interactive model selection with autocomplete"));

        out.print(pc.bold("  /output <format>") + pc.dim("     Change output format"));
        out.print(pc.dim("    Formats: text, json, markdown, clipboard, file <filename>"));
        out.print(pc.dim("    Example: /output file chat.txt"));

        out.print(pc.bold("  /clear") + pc.dim("              Clear conversation history"));
        out.print(pc.dim("    Removes all messages from current session"));

        out.print(pc.bold("  /save") + pc.dim("               Save current conversation"));
        out.print(pc.dim("    Manually saves conversation to disk"));

        out.print(pc.bold("  /sst <file>") + pc.dim("           Transcribe audio file"));
        out.print(pc.dim("    Supports MP3, WAV, M4A, FLAC, OGG, WebM"));
        out.print(pc.dim("    Example: /sst recording.mp3"));

        out.print(pc.bold("  /context") + pc.dim("            Show loaded context artifacts"));
        out.print(pc.dim("    Displays .genesistoolscontext.json content"));

        out.print(pc.bold("  /tools") + pc.dim("              List available AI tools"));
        out.print(pc.dim("    Shows readFile, grep, bash, searchWeb, etc."));

        out.print(pc.bold("  /history") + pc.dim("            Show conversation stats"));
        out.print(pc.dim("    Message count and estimated token usage"));

        out.print(pc.bold("  /system") + pc.dim("             Show current system prompt"));
        out.print(pc.dim("    Displays the system prompt (truncated to 500 chars)"));

        out.print(pc.bold("  /help") + pc.dim("               Show this help message"));
        out.print(pc.dim("    Displays all available commands"));

        out.print(pc.bold("  /quit") + pc.dim("               Exit the chat session"));
        out.print(pc.bold("  /exit") + pc.dim("               Exit the chat session"));
        out.print();

        out.print(pc.yellow("Tips:"));
        out.print(pc.dim("  - Commands can be entered at any time during chat"));
        out.print(pc.dim("  - Use Tab to autocomplete in model selection"));
        out.print(pc.dim("  - Audio files are automatically transcribed with optimal provider"));
        out.print(pc.dim("  - Conversations are auto-saved every 5 messages"));
        out.print();
    }

    isValidCommand(message: string): boolean {
        if (!message.startsWith("/")) {
            return true; // Regular messages are always valid
        }

        const parts = message.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const validCommands = [
            "/model",
            "/output",
            "/quit",
            "/exit",
            "/clear",
            "/save",
            "/sst",
            "/context",
            "/tools",
            "/history",
            "/system",
            "/help",
        ];

        return validCommands.includes(cmd);
    }

    isCommand(message: string): boolean {
        return message.startsWith("/");
    }

    async confirmAction(message: string): Promise<boolean> {
        const result = await p.confirm({
            message,
            initialValue: false,
        });
        if (p.isCancel(result)) {
            return false;
        }
        return result;
    }

    async getInput(prompt: string, secure = false): Promise<string> {
        const result = secure
            ? await p.password({ message: prompt })
            : await p.text({
                  message: prompt,
                  validate: (value) => {
                      if (!value?.trim()) {
                          return "This field is required.";
                      }
                      return undefined;
                  },
              });

        if (p.isCancel(result)) {
            throw new Error("Input cancelled");
        }
        return result;
    }

    async selectFromList(prompt: string, choices: string[]): Promise<string | null> {
        const result = await p.select({
            message: prompt,
            options: choices.map((choice) => ({
                value: choice,
                label: choice,
            })),
        });
        if (p.isCancel(result)) {
            return null;
        }
        return result;
    }

    formatFileSize(bytes: number): string {
        const units = ["B", "KB", "MB", "GB"];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(1)} ${units[unitIndex]}`;
    }

    async showProgress(message: string, duration: number): Promise<void> {
        const spinner = p.spinner();
        spinner.start(message);
        await new Promise((resolve) => setTimeout(resolve, duration));
        spinner.stop(message);
    }
}

// Singleton instance
export const commandHandler = new CommandHandler();
