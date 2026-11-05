import { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { shellQuote } from "@genesiscz/utils/shell/quote";
import { toolDataDir } from "@genesiscz/utils/storage/root";

/**
 * A host's health probe (`--version`, `--help`) reads no login, so it runs without an account. T3 Code runs
 * `--version` on every status refresh of every instance (every 5 minutes, 14 Claude instances on 2026-11-02), and an
 * account launch loads the vault and the whole config for an answer that changes only when the binary does.
 */
const ACCOUNTLESS_ARGV = new Set(["--version", "-V", "--help", "-h"]);

export function isAccountlessProbe(argv: readonly string[]): boolean {
    return argv.length === 1 && ACCOUNTLESS_ARGV.has(argv[0] ?? "");
}

/**
 * The last `--version` answer of an alias's binary, which the launcher prints without starting Bun while the binary
 * is unchanged. Line 1: the binary path the answer came from (a symlink stays a symlink). Line 2: what it pointed to.
 * The rest: the binary's stdout.
 */
export function embedVersionCachePath(alias: string): string {
    return toolDataDir(alias, "embed-version.txt");
}

export interface VersionProbeDeps {
    spawn(
        argv: string[],
        env: Record<string, string | undefined>
    ): { stdout: Promise<string>; exited: Promise<number> };
    write(text: string): void;
}

const defaultDeps: VersionProbeDeps = {
    spawn(argv, env) {
        const proc = Bun.spawn({ cmd: argv, stdin: "ignore", stdout: "pipe", stderr: "inherit", env });
        return { stdout: new Response(proc.stdout).text(), exited: proc.exited };
    },
    write: (text) => process.stdout.write(text),
};

/**
 * Runs `<binary> --version`, prints its answer and keeps it in `cachePath` for the launcher. Only a clean exit is kept,
 * so a broken binary is asked again on the next probe.
 */
export async function answerVersionProbe(
    input: { binary: string; env: Record<string, string | undefined>; cachePath: string },
    deps: VersionProbeDeps = defaultDeps
): Promise<number> {
    const proc = deps.spawn([input.binary, "--version"], input.env);
    const [stdout, code] = await Promise.all([proc.stdout, proc.exited]);
    deps.write(stdout);

    if (code !== 0 || stdout.trim() === "" || !existsSync(input.binary)) {
        return code;
    }

    try {
        await mkdir(dirname(input.cachePath), { recursive: true });
        await writeFile(input.cachePath, `${input.binary}\n${realpathSync(input.binary)}\n${stdout}`);
    } catch (error) {
        logger.debug({ error, path: input.cachePath }, "[embed] version answer not cached");
    }

    return code;
}

/**
 * The launcher lines that answer a bare `--version` from `embedVersionCachePath`, with no Bun start, while the binary
 * still points where it did and is older than the answer. Anything else falls through to the exec line.
 */
export function versionFastPathLines(alias: string): string[] {
    const cache = shellQuote(embedVersionCachePath(alias));

    return [
        "# A host's bare --version (T3 Code asks on every status refresh) is the binary's last answer while the binary is unchanged.",
        `if [[ $# -eq 1 && $1 == --version && -r ${cache} ]]; then`,
        `    embed_version=("\${(@f)$(<${cache})}")`,
        `    for embed_candidate in "$HOME/.bun/bin/${alias}" "$HOME/.local/bin/${alias}"; do`,
        "        if [[ -x $embed_candidate ]]; then",
        '            if [[ $embed_candidate != "${embed_version[1]}" ]]; then embed_version=(); fi',
        "            break",
        "        fi",
        "    done",
        `    if [[ -n \${embed_version[1]} && \${embed_version[1]:A} == "\${embed_version[2]}" && ${cache} -nt \${embed_version[2]} ]]; then`,
        '        print -r -- "${(F)embed_version[3,-1]}"',
        "        exit 0",
        "    fi",
        "fi",
    ];
}
