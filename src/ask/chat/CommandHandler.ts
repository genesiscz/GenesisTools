import Enquirer from "enquirer";
import { LanguageModel } from "ai";
import chalk from "chalk";
import logger from "../../logger";
import type { OutputConfig, OutputFormat } from "../types";
import { modelSelector } from "../providers/ModelSelector";

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
  private prompter = new Enquirer();

  async handleCommand(
    command: string,
    currentProvider: string,
    currentModelName: string
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
        case "/help":
          return { showHelp: true };
        default:
          logger.error(`Unknown command: ${cmd}. Type /help for available commands.`);
          return {};
      }
    } catch (error) {
      if (error instanceof Error && error.message === "canceled") {
        logger.info("\nCommand cancelled.");
        return {};
      }
      logger.error(`Error executing command ${cmd}: ${error}`);
      return {};
    }
  }

  private async handleModelCommand(): Promise<CommandResult> {
    logger.info(chalk.blue("\n🔄 Selecting new model..."));

    const newChoice = await modelSelector.selectModel();
    if (!newChoice) {
      return {};
    }

    logger.info(chalk.green(`✓ Switched to ${newChoice.provider.name}/${newChoice.model.name}`));

    return {
      newModel: newChoice.provider.provider(newChoice.model.id),
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
    console.log(chalk.cyan("\nAvailable output formats:"));
    console.log(chalk.white("  text        ") + chalk.gray("Plain text output (default)"));
    console.log(chalk.white("  json        ") + chalk.gray("Structured JSON responses"));
    console.log(chalk.white("  markdown    ") + chalk.gray("Markdown formatted output"));
    console.log(chalk.white("  clipboard   ") + chalk.gray("Auto-copy responses to clipboard"));
    console.log(chalk.white("  file <name> ") + chalk.gray("Save responses to specified file"));
    console.log(chalk.gray("\nUsage: /output <format>"));
    console.log(chalk.gray("Example: /output file responses.txt"));
  }

  private async handleSSTCommand(args: string[]): Promise<CommandResult> {
    if (args.length === 0) {
      const response = await this.prompter.prompt({
        type: "input",
        name: "file",
        message: "Enter audio file path:",
        validate: (input: string) => {
          if (!input.trim()) {
            return "Please enter a file path.";
          }
          return true;
        },
      }) as { file: string };

      return { transcriptionFile: response.file };
    }

    const filePath = args.join(" ");
    return { transcriptionFile: filePath };
  }

  showHelp(): void {
    console.log(chalk.cyan("\n📖 Available Commands:"));
    console.log();

    console.log(chalk.white("  /model") + chalk.gray("              Switch to a different AI model"));
    console.log(chalk.gray("    Opens interactive model selection with autocomplete"));

    console.log(chalk.white("  /output <format>") + chalk.gray("     Change output format"));
    console.log(chalk.gray("    Formats: text, json, markdown, clipboard, file <filename>"));
    console.log(chalk.gray("    Example: /output file chat.txt"));

    console.log(chalk.white("  /clear") + chalk.gray("              Clear conversation history"));
    console.log(chalk.gray("    Removes all messages from current session"));

    console.log(chalk.white("  /save") + chalk.gray("               Save current conversation"));
    console.log(chalk.gray("    Manually saves conversation to disk"));

    console.log(chalk.white("  /sst <file>") + chalk.gray("           Transcribe audio file"));
    console.log(chalk.gray("    Supports MP3, WAV, M4A, FLAC, OGG, WebM"));
    console.log(chalk.gray("    Example: /sst recording.mp3"));

    console.log(chalk.white("  /help") + chalk.gray("               Show this help message"));
    console.log(chalk.gray("    Displays all available commands"));

    console.log(chalk.white("  /quit") + chalk.gray("               Exit the chat session"));
    console.log(chalk.white("  /exit") + chalk.gray("               Exit the chat session"));
    console.log();

    console.log(chalk.yellow("💡 Tips:"));
    console.log(chalk.gray("  • Commands can be entered at any time during chat"));
    console.log(chalk.gray("  • Use Tab to autocomplete in model selection"));
    console.log(chalk.gray("  • Audio files are automatically transcribed with optimal provider"));
    console.log(chalk.gray("  • Conversations are auto-saved every 5 messages"));
    console.log();
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
      "/help",
    ];

    return validCommands.includes(cmd);
  }

  isCommand(message: string): boolean {
    return message.startsWith("/");
  }

  async confirmAction(message: string): Promise<boolean> {
    try {
      const response = await this.prompter.prompt({
        type: "confirm",
        name: "confirmed",
        message,
        initial: false,
      }) as { confirmed: boolean };

      return response.confirmed;
    } catch (error) {
      if (error instanceof Error && error.message === "canceled") {
        return false;
      }
      throw error;
    }
  }

  async getInput(prompt: string, secure = false): Promise<string> {
    try {
      const response = await this.prompter.prompt({
        type: secure ? "password" : "input",
        name: "input",
        message: prompt,
        validate: (input: string) => {
          if (!input.trim()) {
            return "This field is required.";
          }
          return true;
        },
      }) as { input: string };

      return response.input;
    } catch (error) {
      if (error instanceof Error && error.message === "canceled") {
        throw new Error("canceled");
      }
      throw error;
    }
  }

  async selectFromList(prompt: string, choices: string[]): Promise<string | null> {
    try {
      const response = await this.prompter.prompt({
        type: "select",
        name: "choice",
        message: prompt,
        choices: choices.map(choice => ({
          name: choice,
          message: choice,
        })),
      }) as { choice: string };

      return response.choice;
    } catch (error) {
      if (error instanceof Error && error.message === "canceled") {
        return null;
      }
      throw error;
    }
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
    const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let index = 0;

    const interval = setInterval(() => {
      process.stdout.write(`\r${spinner[index]} ${message}`);
      index = (index + 1) % spinner.length;
    }, 100);

    await new Promise(resolve => setTimeout(resolve, duration));

    clearInterval(interval);
    process.stdout.write(`\r${chalk.green("✓")} ${message}\n`);
  }
}

// Singleton instance
export const commandHandler = new CommandHandler();