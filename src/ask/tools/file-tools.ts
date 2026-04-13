import { existsSync, readFileSync } from "node:fs";
import { tool } from "ai";
import { z } from "zod";

const readFileSchema = z.object({
    path: z.string().describe("File path to read"),
    maxLines: z.number().optional().describe("Max lines to read (default: all)"),
});

const grepSchema = z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    path: z.string().optional().describe("Directory or file to search in (default: .)"),
    glob: z.string().optional().describe("File glob pattern (e.g. '*.ts')"),
});

const bashSchema = z.object({
    command: z.string().describe("Shell command to execute"),
    timeout: z.number().optional().describe("Timeout in ms (default: 10000)"),
});

export function getFileTools() {
    return {
        readFile: tool({
            description: "Read a file from the local filesystem. Use absolute or relative paths.",
            inputSchema: readFileSchema,
            execute: async ({ path, maxLines }: z.infer<typeof readFileSchema>) => {
                if (!existsSync(path)) {
                    return `Error: File not found: ${path}`;
                }

                const content = readFileSync(path, "utf-8");
                const lines = content.split("\n");

                if (maxLines && lines.length > maxLines) {
                    return lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more lines)`;
                }

                return content;
            },
        }),

        grep: tool({
            description: "Search for a pattern in files using ripgrep. Returns matching lines with file paths and line numbers.",
            inputSchema: grepSchema,
            execute: async ({ pattern, path, glob }: z.infer<typeof grepSchema>) => {
                const args = ["rg", "--no-heading", "-n", pattern];

                if (glob) {
                    args.push("--glob", glob);
                }

                args.push(path ?? ".");

                try {
                    const proc = Bun.spawnSync(args, {
                        stdout: "pipe",
                        stderr: "pipe",
                    });

                    if (proc.exitCode === 1) {
                        return "No matches found.";
                    }

                    if (proc.exitCode !== 0) {
                        const stderr = proc.stderr.toString().trim();
                        return `Error: ${stderr || `rg exited with code ${proc.exitCode}`}`;
                    }

                    return proc.stdout.toString().slice(0, 5000);
                } catch (err) {
                    return `Error: ${err instanceof Error ? err.message : String(err)}`;
                }
            },
        }),

        bash: tool({
            description: "Execute a shell command and return its output. Use for git, ls, find, and other CLI tools.",
            inputSchema: bashSchema,
            execute: async ({ command, timeout }: z.infer<typeof bashSchema>) => {
                try {
                    const proc = Bun.spawnSync(["zsh", "-c", command], {
                        stdout: "pipe",
                        stderr: "pipe",
                        timeout: timeout ?? 10_000,
                    });

                    const stdout = proc.stdout.toString();
                    const stderr = proc.stderr.toString();

                    if (proc.exitCode !== 0) {
                        return `${stdout}\n${stderr}`.trim() || `Error: command exited with code ${proc.exitCode}`;
                    }

                    return stdout.slice(0, 10_000);
                } catch (err) {
                    return `Error: ${err instanceof Error ? err.message : String(err)}`;
                }
            },
        }),
    };
}
