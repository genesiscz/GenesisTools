import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

export function createCaptureRuntimeLogger(options: { directory?: string } = {}) {
    let previous: string | undefined;
    function writeDiagnostic(input: { level: "debug" | "warn" | "error"; context: object; message: string }): void {
        const { level, context, message } = input;
        const detail =
            "error" in context && context.error instanceof Error
                ? { ...context, error: { name: context.error.name, message: context.error.message } }
                : context;
        const signature = SafeJSON.stringify({ level, message, ...detail });
        if (signature === previous) {
            return;
        }

        const directory = options.directory ?? join(env.tools.getHome(), ".genesis-tools/cmux");
        let line = `${SafeJSON.stringify({ at: new Date().toISOString(), level, message, ...detail })}\n`;
        if (Buffer.byteLength(line) > 65536) {
            line = `${SafeJSON.stringify({ at: new Date().toISOString(), level, message: message.slice(0, 1024), detail: "oversized diagnostic omitted" })}\n`;
        }

        try {
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            const path = join(directory, "capture-runtime.log");
            if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > 1024 * 1024) {
                renameSync(path, `${path}.previous`);
            }

            appendFileSync(path, line, { mode: 0o600 });
            previous = signature;
        } catch (error) {
            process.stderr.write(
                `cmux capture diagnostic log failed: ${error instanceof Error ? error.message : String(error)}\n`
            );
        }

        if (level !== "debug" && !process.argv.includes("--owner-token")) {
            process.stderr.write(`${message}\n`);
        }
    }

    return {
        debug(context: object, message: string): void {
            writeDiagnostic({ level: "debug", context, message });
        },
        warn(context: object, message: string): void {
            writeDiagnostic({ level: "warn", context, message });
        },
        error(context: object, message: string): void {
            writeDiagnostic({ level: "error", context, message });
        },
    };
}

/** Bundled recorder diagnostics avoid shared logger's dynamic package loading. */
export const logger = createCaptureRuntimeLogger();
