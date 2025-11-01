import { randomBytes } from "node:crypto";
import chalk from "chalk";
import type { LanguageModelUsage } from "../types";

export function generateSessionId(): string {
  const timestamp = new Date().toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .split("Z")[0];
  const random = randomBytes(3).toString("hex");
  return `${timestamp}_${random}`;
}

export function estimateTokens(text: string): number {
  // Rough estimation: ~4 characters per token for English
  // This is a very rough approximation and actual token count varies by model
  return Math.ceil(text.length / 4);
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  } else if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

export function truncateText(text: string, maxLength: number = 100): string {
  if (text.length <= maxLength) {
    return text;
  }

  return text.substring(0, maxLength - 3) + "...";
}

export function colorizeRole(role: string): string {
  switch (role.toLowerCase()) {
    case "user":
      return chalk.blue("User");
    case "assistant":
      return chalk.green("Assistant");
    case "system":
      return chalk.magenta("System");
    default:
      return chalk.gray(role);
  }
}

export function colorizeProvider(provider: string): string {
  const colors = [
    chalk.cyan,
    chalk.magenta,
    chalk.yellow,
    chalk.blue,
    chalk.green,
  ];

  const colorIndex = provider.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length;
  return colors[colorIndex](provider);
}

export function createProgressBar(current: number, total: number, width: number = 40): string {
  const percentage = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(width * percentage);
  const empty = width - filled;

  const filledBar = "█".repeat(filled);
  const emptyBar = "░".repeat(empty);
  const percentageText = `${Math.round(percentage * 100)}%`;

  return `[${filledBar}${emptyBar}] ${percentageText}`;
}

export function formatUsage(usage?: LanguageModelUsage): string {
  if (!usage) {
    return "";
  }

  const parts: string[] = [];

  if (usage.promptTokens) {
    parts.push(`Input: ${formatTokens(usage.promptTokens)}`);
  }

  if (usage.completionTokens) {
    parts.push(`Output: ${formatTokens(usage.completionTokens)}`);
  }

  if (usage.totalTokens) {
    parts.push(`Total: ${formatTokens(usage.totalTokens)}`);
  }

  if (usage.cachedPromptTokens && usage.cachedPromptTokens > 0) {
    parts.push(`Cached: ${formatTokens(usage.cachedPromptTokens)}`);
  }

  return parts.join(", ");
}

export function validateAPIKey(key: string, provider: string): boolean {
  // Basic validation - these are simple heuristics and not foolproof
  const minLengths: Record<string, number> = {
    openai: 20,
    anthropic: 20,
    google: 20,
    groq: 20,
    openrouter: 20,
    "xai": 20,
    jinaai: 20,
  };

  const minLength = minLengths[provider] || 20;

  if (key.length < minLength) {
    return false;
  }

  // Check for common patterns that indicate invalid keys
  const invalidPatterns = [
    /^your_api_key_here$/i,
    /^sk-test-/i, // OpenAI test keys (usually not for production)
    /^placeholder$/i,
    /^xxx+/i,
  ];

  if (invalidPatterns.some(pattern => pattern.test(key))) {
    return false;
  }

  return true;
}

export function sanitizeOutput(text: string, removeANSI: boolean = false): string {
  let sanitized = text;

  if (removeANSI) {
    // Remove ANSI escape codes
    sanitized = sanitized.replace(/\x1b\[[0-9;]*m/g, "");
  }

  // Remove other potentially problematic characters
  sanitized = sanitized.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

  return sanitized;
}

export function parseJSON<T>(text: string, fallback?: T): T | null {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }
    return null;
  }
}

export function debounce<T extends (...args: unknown[]) => void>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout;

  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

export function throttle<T extends (...args: unknown[]) => void>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;

  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

export function retry<T>(
  operation: () => Promise<T>,
  maxAttempts: number = 3,
  delay: number = 1000
): Promise<T> {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryOperation = async () => {
      try {
        const result = await operation();
        resolve(result);
      } catch (error) {
        attempt++;
        if (attempt >= maxAttempts) {
          reject(error);
        } else {
          setTimeout(tryOperation, delay * Math.pow(2, attempt - 1)); // Exponential backoff
        }
      }
    };

    tryOperation();
  });
}

export function formatFileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    if (source[key] && isObject(source[key]) && isObject(result[key])) {
      result[key] = deepMerge(result[key], source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key] as any;
    }
  }

  return result;
}

export function getEnvVar(name: string, required: boolean = false): string | undefined {
  const value = process.env[name];

  if (required && !value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }

  return value;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError?: Error
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(timeoutError || new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]);
}