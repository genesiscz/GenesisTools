import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

/**
 * Handle --readme flag for CLI tools.
 * Call this early in your tool, passing import.meta.url.
 * If --readme is present in argv, prints README and exits.
 *
 * @param importMetaUrl - Pass `import.meta.url` from calling module
 * @returns void (exits process if --readme flag found)
 */
export function handleReadmeFlag(importMetaUrl: string): void {
    if (!process.argv.includes("--readme")) {
        return;
    }

    const __filename = fileURLToPath(importMetaUrl);
    const __dirname = dirname(__filename);
    const readmePath = resolve(__dirname, "README.md");

    if (existsSync(readmePath)) {
        const content = readFileSync(readmePath, "utf-8");
        console.log(content);
        process.exit(0);
    } else {
        console.log("No README.md found for this tool.");
        process.exit(1);
    }
}
