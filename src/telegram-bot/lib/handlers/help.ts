import { registerCommand, getRegisteredCommands } from "../dispatcher";

registerCommand("help", async () => {
  const commands = getRegisteredCommands();
  const lines = [
    "Available commands:",
    "",
    ...commands.map(c => `/${c}`),
  ];
  return { text: lines.join("\n") };
});
