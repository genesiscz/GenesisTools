const ANSI_REGEX = /\x1B\[[0-9;]*[a-zA-Z]/g;
const MAX_MESSAGE_LENGTH = 4096;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

export function truncateForTelegram(text: string): string {
  const clean = stripAnsi(text);
  if (clean.length <= MAX_MESSAGE_LENGTH) return clean;
  return `${clean.slice(0, MAX_MESSAGE_LENGTH - 20)}\n... (truncated)`;
}

export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}
