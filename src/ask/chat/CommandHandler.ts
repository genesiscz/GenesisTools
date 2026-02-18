import logger from "@app/logger";
import { modelSelector } from "@ask/providers/ModelSelector";
import type { OutputConfig, OutputFormat } from "@ask/types";
import { getLanguageModel } from "@ask/types";
import * as p from "@clack/prompts";
import type { LanguageModel } from "ai";
import pc from "picocolors";

export interface CommandResult {
    shouldExit?: boolean;
    newModel?: LanguageModel;
    newProvider?: string;
    newModelName?: string;
    outputFormat?: OutputConfig;
    clearHistory?: boolean;
    saveConversation?: boolean;
    transcriptionFile?: string;
    showHelp?: boolean;
}

export class CommandHandler {
    async handleCommand(command: string, _currentProvider: string, _currentModelName: string): Promise<CommandResult> {
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

        const model = getLanguageModel(newChoice.provider.provider, newChoice.model.id);
        return {
            newModel: model,
            newProvider: newChoice.provider.name,
            newModelName: newChoice.model.id,
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
        console.log(pc.cyan("\nAvailable output formats:"));
        console.log(pc.bold("  text        ") + pc.dim("Plain text output (default)"));
        console.log(pc.bold("  json        ") + pc.dim("Structured JSON responses"));
        console.log(pc.bold("  markdown    ") + pc.dim("Markdown formatted output"));
        console.log(pc.bold("  clipboard   ") + pc.dim("Auto-copy responses to clipboard"));
        console.log(pc.bold("  file <name> ") + pc.dim("Save responses to specified file"));
        console.log(pc.dim("\nUsage: /output <format>"));
        console.log(pc.dim("Example: /output file responses.txt"));
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

            if (p.isCancel(file)) return {};
            return { transcriptionFile: file };
        }

        const filePath = args.join(" ");
        return { transcriptionFile: filePath };
    }

    showHelp(): void {
        console.log(pc.cyan("\nAvailable Commands:"));
        console.log();

        console.log(pc.bold("  /model") + pc.dim("              Switch to a different AI model"));
        console.log(pc.dim("    Opens interactive model selection with autocomplete"));

        console.log(pc.bold("  /output <format>") + pc.dim("     Change output format"));
        console.log(pc.dim("    Formats: text, json, markdown, clipboard, file <filename>"));
        console.log(pc.dim("    Example: /output file chat.txt"));

        console.log(pc.bold("  /clear") + pc.dim("              Clear conversation history"));
        console.log(pc.dim("    Removes all messages from current session"));

        console.log(pc.bold("  /save") + pc.dim("               Save current conversation"));
        console.log(pc.dim("    Manually saves conversation to disk"));

        console.log(pc.bold("  /sst <file>") + pc.dim("           Transcribe audio file"));
        console.log(pc.dim("    Supports MP3, WAV, M4A, FLAC, OGG, WebM"));
        console.log(pc.dim("    Example: /sst recording.mp3"));

        console.log(pc.bold("  /help") + pc.dim("               Show this help message"));
        console.log(pc.dim("    Displays all available commands"));

        console.log(pc.bold("  /quit") + pc.dim("               Exit the chat session"));
        console.log(pc.bold("  /exit") + pc.dim("               Exit the chat session"));
        console.log();

        console.log(pc.yellow("Tips:"));
        console.log(pc.dim("  - Commands can be entered at any time during chat"));
        console.log(pc.dim("  - Use Tab to autocomplete in model selection"));
        console.log(pc.dim("  - Audio files are automatically transcribed with optimal provider"));
        console.log(pc.dim("  - Conversations are auto-saved every 5 messages"));
        console.log();
    }

    isValidCommand(message: string): boolean {
        if (!message.startsWith("/")) {
            return true; // Regular messages are always valid
        }

        const parts = message.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const validCommands = ["/model", "/output", "/quit", "/exit", "/clear", "/save", "/sst", "/help"];

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
        if (p.isCancel(result)) return false;
        return result;
    }

    async getInput(prompt: string, secure = false): Promise<string> {
        const result = secure
            ? await p.password({ message: prompt })
            : await p.text({
                  message: prompt,
                  validate: (value) => {
                      if (!value?.trim()) return "This field is required.";
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
        if (p.isCancel(result)) return null;
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
