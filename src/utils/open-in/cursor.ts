import { existsSync } from "node:fs";
import { Executor } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";
import type { ArgvRunner, EditorDriver, EditorTarget } from "./types";

/** The CLI inside the app bundle; `~/.local/bin/cursor` can be a shim that exits when the IDE is missing. */
const APP_CLI = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";

const log = logger.child({ component: "open-in/cursor" });

export const defaultArgvRunner: ArgvRunner = async (argv, { cwd, timeoutMs }) => {
    const res = await new Executor({ cwd }).exec(argv, { timeout: timeoutMs });
    return { code: res.exitCode, stdout: res.stdout, stderr: res.stderr };
};

export function resolveCursorBinary(): string | null {
    if (existsSync(APP_CLI)) {
        return APP_CLI;
    }

    return Bun.which("cursor");
}

/** `cursor <root> --goto <file>:<line>:<col>`: opens (or reuses) the root's window at that line. */
export function cursorArgv(binary: string, target: EditorTarget): string[] {
    if (!target.file) {
        return [binary, target.root];
    }

    const position = [target.file, target.line, target.line ? target.column : undefined]
        .filter((part) => part !== undefined)
        .join(":");

    return [binary, target.root, "--goto", position];
}

export function cursorDriver({
    runner = defaultArgvRunner,
    binary = resolveCursorBinary,
}: {
    runner?: ArgvRunner;
    binary?: () => string | null;
} = {}): EditorDriver {
    return {
        kind: "editor",
        id: "cursor",
        label: "Cursor",
        async open(target) {
            const bin = binary();

            if (!bin) {
                throw new Error("Cursor is not installed (no Cursor.app and no cursor on PATH)");
            }

            const argv = cursorArgv(bin, target);
            log.info({ argv }, "opening in Cursor");
            const res = await runner(argv, { cwd: target.root, timeoutMs: 15_000 });

            if (res.code !== 0) {
                throw new Error(`cursor exited ${res.code}: ${res.stderr || res.stdout}`);
            }

            return { driver: "cursor", detail: argv.slice(1).join(" ") };
        },
    };
}
