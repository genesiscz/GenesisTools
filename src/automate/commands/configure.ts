import { Command } from "commander";
import * as p from "@clack/prompts";

export function registerConfigureCommand(program: Command): void {
  program.command("configure").description("Interactive setup wizard").action(async () => {
    p.intro("automate configure");
    const section = await p.select({
      message: "What would you like to configure?",
      options: [
        { value: "telegram", label: "Telegram Bot", hint: "Set up notifications via Telegram" },
        { value: "done", label: "Done", hint: "Exit configuration" },
      ],
    });
    if (p.isCancel(section) || section === "done") { p.outro("Configuration complete"); return; }
    if (section === "telegram") {
      p.log.info("Launching Telegram Bot configuration...");
      const toolsPath = new URL("../../../tools", import.meta.url).pathname;
      const proc = Bun.spawn(["bun", "run", toolsPath, "telegram-bot", "configure"], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      await proc.exited;
    }
    p.outro("Configuration complete");
  });
}
