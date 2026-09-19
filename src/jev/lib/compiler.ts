import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform, kill as signalProcess } from "node:process";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { argvWithChildDeadline } from "@genesiscz/utils/process/child-deadline";
import { compilers } from "./compilers/registry";
import { sandboxCommand } from "./compilers/sandbox";
import { experimentRequestSchema } from "./experiment-contract";
import { generationMode } from "./generation";
import { languages } from "./languages";

export interface ProcessOutput {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}
export interface CompileResult {
    source: string;
    compiler: string;
    build: ProcessOutput;
    run?: ProcessOutput;
}

async function runCompilerProcess({
    cmd,
    cwd,
    stdin = "",
    timeoutMs,
    signal,
}: {
    cmd: string[];
    cwd: string;
    stdin?: string;
    timeoutMs: number;
    signal?: AbortSignal;
}): Promise<ProcessOutput> {
    signal?.throwIfAborted();
    logger.debug({ command: cmd[0], cwd, timeoutMs }, "Starting Jev compiler process");
    const child = Bun.spawn({
        cmd: argvWithChildDeadline(cmd, timeoutMs),
        detached: platform !== "win32",
        cwd,
        env: { PATH: env.get("PATH"), LANG: "C", TMPDIR: tmpdir() },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });
    let timedOut = false;
    const stop = () => {
        if (child.exitCode === null) {
            if (platform === "win32") {
                child.kill("SIGKILL");
            } else {
                signalProcess(-child.pid, "SIGKILL");
            }
        }
    };
    const timer = setTimeout(() => {
        timedOut = true;
        stop();
    }, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) {
        stop();
    }
    const collect = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let output = "";
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) {
                    return output + decoder.decode();
                }

                output += decoder.decode(chunk.value, { stream: true });
                if (output.length > 32768) {
                    stop();
                    return `${output.slice(0, 32768)}\n[output limit reached]`;
                }
            }
        } finally {
            reader.releaseLock();
        }
    };
    try {
        child.stdin.write(stdin);
        child.stdin.end();
        const [stdout, stderr, exitCode] = await Promise.all([
            collect(child.stdout),
            collect(child.stderr),
            child.exited,
        ]);
        signal?.throwIfAborted();
        return { stdout, stderr, exitCode, timedOut };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
    }
}

export async function compileExperiment({
    input,
    signal,
}: {
    input: unknown;
    signal?: AbortSignal;
}): Promise<CompileResult> {
    const request = experimentRequestSchema.parse(input);
    const language = languages.get(request.language);
    const state = generationMode(request.mode).state(language, request);
    if (!state.complete) {
        throw new Error("Finish the program before type-checking and running.");
    }

    const driver = compilers.get(language.id);
    const dir = await mkdtemp(join(tmpdir(), "jev-program-"));
    try {
        const source = join(dir, `main.${language.fileExtension}`);
        await Bun.write(source, state.source);
        const plan = await driver.prepare(source);
        const protect = (cmd: string[]) =>
            request.mode === "characters" ? sandboxCommand({ cmd, directory: dir, readPaths: plan.readPaths }) : cmd;
        const build = await runCompilerProcess({
            cmd: protect(plan.check),
            cwd: dir,
            timeoutMs: 30000,
            signal,
        });
        if (build.exitCode !== 0) {
            return { source: state.source, compiler: plan.label, build };
        }

        const run = await runCompilerProcess({
            cmd: protect(plan.execute),
            cwd: dir,
            stdin: request.stdin,
            timeoutMs: 3000,
            signal,
        });
        return { source: state.source, compiler: plan.label, build, run };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
