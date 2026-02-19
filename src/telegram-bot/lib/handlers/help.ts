import type { Bot } from "grammy";

const COMMANDS = [
  { command: "status", description: "Daemon status and active schedules" },
  { command: "tasks", description: "Recent run history" },
  { command: "run", description: "Trigger a preset" },
  { command: "tools", description: "Run any tools command" },
  { command: "help", description: "Show this help" },
];

export function registerHelpCommand(bot: Bot): void {
  bot.command("help", async (ctx) => {
    const lines = [
      "Available commands:",
      "",
      ...COMMANDS.map(c => `/${c.command} — ${c.description}`),
    ];
    await ctx.reply(lines.join("\n"));
  });
}

export { COMMANDS };
