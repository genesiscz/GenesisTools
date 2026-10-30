import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, readFileIfExistsSync } from "@genesiscz/utils/storage/atomic-file";
import type { CompletionProvider } from "./providers";
import { completionFilePath } from "./rc-block";
import type { CompletionsState, InstalledCompletion } from "./state";

/** A generator that runs every subcommand's --help to build its script took 37 s at load average 45 (2026-10-30). */
const GENERATE_TIMEOUT_MS = 120_000;
const VERSION_TIMEOUT_MS = 10_000;

export interface CommandOutput {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export interface RunOptions {
    env?: Readonly<Record<string, string>>;
    timeoutMs: number;
}

/** Runs one argv; injected in tests so no fake executable is ever started. */
export type CommandRunner = (argv: readonly string[], options: RunOptions) => Promise<CommandOutput>;

/** Finds a command on PATH; injected in tests. */
export type CommandLocator = (cli: string) => string | null;

export const runCommand: CommandRunner = async (argv, options) => {
    logger.debug({ argv, timeoutMs: options.timeoutMs }, "zsh completions: running");
    const proc = Bun.spawn([...argv], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: options.env ? { ...env.getProcessEnv(), ...options.env } : undefined,
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    const timedOut = proc.signalCode === "SIGKILL";
    logger.debug({ argv, exitCode, timedOut, bytes: stdout.length }, "zsh completions: finished");
    return { exitCode, stdout, stderr, timedOut };
};

export const locateCommand: CommandLocator = (cli) => Bun.which(cli);

export interface FoundProvider {
    provider: CompletionProvider;
    path: string;
}

export function detectProviders(
    providers: readonly CompletionProvider[],
    locate: CommandLocator = locateCommand
): FoundProvider[] {
    const found: FoundProvider[] = [];

    for (const provider of providers) {
        const path = locate(provider.cli);

        if (path) {
            found.push({ provider, path });
        }
    }

    return found;
}

/** The first line of `<cli> --version`, or undefined when it fails or prints nothing. */
export async function readVersion(
    provider: CompletionProvider,
    run: CommandRunner = runCommand
): Promise<string | undefined> {
    try {
        const output = await run(provider.version, { timeoutMs: VERSION_TIMEOUT_MS });

        if (output.exitCode !== 0) {
            logger.debug({ cli: provider.cli, exitCode: output.exitCode }, "zsh completions: version command failed");
            return undefined;
        }

        const line = `${output.stdout}\n${output.stderr}`.split("\n").find((entry) => entry.trim() !== "");
        return line?.trim();
    } catch (error) {
        logger.debug({ cli: provider.cli, error }, "zsh completions: version command threw");
        return undefined;
    }
}

export function sha256(text: string): string {
    return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** A zsh completion script for `cli` names it on a `#compdef` line near the top. */
export function looksLikeZshCompletion(script: string, cli: string): boolean {
    const head = script.split("\n").slice(0, 5);
    return head.some((line) => line.trim().split(/\s+/)[0] === "#compdef" && line.trim().split(/\s+/).includes(cli));
}

/** Prints the script once and checks it; throws with the reason when it is not a zsh completion for this CLI. */
export async function generateScript(provider: CompletionProvider, run: CommandRunner = runCommand): Promise<string> {
    const output = await run(provider.generate, { env: provider.generateEnv, timeoutMs: GENERATE_TIMEOUT_MS });

    if (output.timedOut) {
        throw new Error(`${provider.generate.join(" ")} did not finish within ${GENERATE_TIMEOUT_MS / 1000} s`);
    }

    if (output.exitCode !== 0) {
        throw new Error(
            `${provider.generate.join(" ")} exited ${output.exitCode}: ${output.stderr.trim().slice(0, 200)}`
        );
    }

    if (!looksLikeZshCompletion(output.stdout, provider.cli)) {
        throw new Error(`${provider.generate.join(" ")} printed no "#compdef ${provider.cli}" script`);
    }

    return output.stdout.endsWith("\n") ? output.stdout : `${output.stdout}\n`;
}

export interface GenerateResult {
    provider: CompletionProvider;
    /** Set when the file was written or already had this content. */
    installed?: InstalledCompletion;
    /** The file content differs from what was there before. */
    changed: boolean;
    previousVersion?: string;
    error?: string;
}

/**
 * Generates each CLI's file into `completionsDir` and returns the state entries. A file whose content is the same
 * is not rewritten. A CLI whose generator fails keeps its old file and entry.
 */
export async function generateCompletions(input: {
    providers: readonly CompletionProvider[];
    completionsDir: string;
    state: CompletionsState;
    run?: CommandRunner;
    now?: Date;
}): Promise<GenerateResult[]> {
    const run = input.run ?? runCommand;
    const now = (input.now ?? new Date()).toISOString();

    return Promise.all(
        input.providers.map(async (provider): Promise<GenerateResult> => {
            const previous = input.state.clis[provider.cli];

            try {
                const [script, version] = await Promise.all([
                    generateScript(provider, run),
                    readVersion(provider, run),
                ]);
                const file = completionFilePath(input.completionsDir, provider.cli);
                const existing = readFileIfExistsSync(file);
                const changed = existing === undefined || Buffer.from(existing).toString("utf8") !== script;

                if (changed) {
                    atomicWriteFileSync(file, script);
                    logger.debug({ cli: provider.cli, file }, "zsh completions: wrote completion file");
                }

                return {
                    provider,
                    changed,
                    previousVersion: previous?.version,
                    installed: { file, wiring: provider.wiring, version, generatedAt: now, sha256: sha256(script) },
                };
            } catch (error) {
                logger.warn({ cli: provider.cli, error }, "zsh completions: generation failed");
                return {
                    provider,
                    changed: false,
                    previousVersion: previous?.version,
                    installed: previous,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        })
    );
}

/** True when the CLI's version now differs from the one its file was generated with. */
export function versionChanged(entry: InstalledCompletion | undefined, current: string | undefined): boolean {
    return entry?.version !== undefined && current !== undefined && entry.version !== current;
}
