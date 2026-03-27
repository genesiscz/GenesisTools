/**
 * Runtime abstraction for file operations
 * Supports both Bun and Node.js runtimes
 */

declare const Bun:
    | {
          file: (path: string) => { text: () => Promise<string> };
          write: (path: string, content: string) => Promise<number>;
      }
    | undefined;

const isBun = typeof Bun !== "undefined";

/**
 * Read file content as text
 * Uses Bun.file() in Bun runtime, fs.promises in Node.js
 */
export async function readFile(path: string): Promise<string> {
    if (isBun) {
        return Bun?.file(path).text();
    }
    const { readFile } = await import("node:fs/promises");
    return readFile(path, "utf-8");
}

/**
 * Write content to file
 * Uses Bun.write() in Bun runtime, fs.promises in Node.js
 */
export async function writeFile(path: string, content: string): Promise<void> {
    if (isBun) {
        await Bun?.write(path, content);
        return;
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, content, "utf-8");
}

/**
 * Check if file exists
 */
export function fileExists(path: string): boolean {
    const { existsSync } = require("node:fs");
    return existsSync(path);
}
