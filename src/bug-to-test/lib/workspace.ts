import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readdir, readFile, realpath, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isProcessGroupAlive } from "@genesiscz/utils/process-alive";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { stripAnsi } from "@genesiscz/utils/string";
import { EXPECTATION_MARKER, generateRepro, PLAYWRIGHT_CONFIG } from "./generate";
import { type BugRecording, parseRecording, type VerificationResult } from "./types";

const log = logger.child({ component: "bug-to-test" });
const dependencyRoot = fileURLToPath(new URL("../../..", import.meta.url));
export const testHash = (source: string) => createHash("sha256").update(source).digest("hex");
export async function saveRecording(options: { path: string; recording: BugRecording }): Promise<void> {
    const recording = parseRecording(options.recording);
    await mkdir(dirname(resolve(options.path)), { recursive: true });
    atomicWriteFileSync(options.path, SafeJSON.stringify(recording, { strict: true }, 2), { mode: 0o600 });
}
export async function loadRecording(path: string): Promise<BugRecording> {
    const file = Bun.file(path);
    if (file.size > 4_000_000) {
        throw new Error("Recording exceeds the 4 MB limit.");
    }
    return parseRecording(SafeJSON.parse(await file.text(), { strict: true }));
}
export async function generateWorkspace(options: { recording: BugRecording; directory?: string }): Promise<string> {
    const recording = parseRecording(options.recording);
    const source = generateRepro(recording);
    const directory = options.directory
        ? resolve(options.directory)
        : toolDataDir("bug-to-test", "workspaces", crypto.randomUUID());
    await mkdir(dirname(directory), { recursive: true });
    await mkdir(directory, { recursive: false });
    await Bun.write(join(directory, "repro.spec.ts"), source);
    await Bun.write(join(directory, "playwright.config.ts"), PLAYWRIGHT_CONFIG);
    await Bun.write(
        join(directory, "tsconfig.json"),
        '{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","strict":true}}'
    );
    await Bun.write(
        join(directory, "package.json"),
        SafeJSON.stringify(
            {
                name: "bug-reproduction",
                private: true,
                scripts: { test: "playwright test" },
                devDependencies: { "@playwright/test": "1.62.1" },
            },
            { strict: true },
            2
        )
    );
    await Bun.write(
        join(directory, "manifest.json"),
        SafeJSON.stringify({ version: 1, testHash: testHash(source), recordingId: recording.id }, { strict: true }, 2)
    );
    await saveRecording({
        path: join(directory, "recording.json"),
        recording: {
            ...recording,
            actions: recording.actions.filter((item) => !item.excluded),
            evidence: recording.evidence.filter((item) => !item.excluded),
            workspace: undefined,
        },
    });
    await Bun.write(
        join(directory, "README.md"),
        `# ${recording.title}\n\n${recording.expectation?.description}\n\nInstall and run:\n\n\`\`\`sh\nnpm install\nnpx playwright install chromium\nnpm test\n\`\`\`\n\nSet BUG_TO_TEST_BASE_URL to point the same assertion at a fixed deployment. BUG_TO_TEST_BROWSER optionally selects an installed Chromium binary. The test opens a fresh context. Authentication and private browser state are intentionally absent; supply local fixtures or login steps yourself if necessary. Reviewed evidence is in recording.json. Traces and the JSON report show the actual run.\n`
    );
    log.info({ directory, recordingId: recording.id }, "generated isolated Playwright workspace");
    return directory;
}

interface ReportResult {
    status?: string;
    errors?: { message?: string }[];
    attachments?: { name?: string; path?: string }[];
}
function resultsOf(value: unknown): ReportResult[] {
    if (!value || typeof value !== "object") {
        return [];
    }
    const record = value as Record<string, unknown>;
    const own = Array.isArray(record.results) ? (record.results as ReportResult[]) : [];
    return own.concat(
        ...["suites", "specs", "tests"].map((key) => (Array.isArray(record[key]) ? record[key].flatMap(resultsOf) : []))
    );
}
export function classifyReport(options: {
    report: unknown;
    exitCode: number;
}): Pick<VerificationResult, "status" | "message" | "trace"> {
    const results = resultsOf(options.report);
    const result = results.length === 1 ? results[0] : undefined;
    const errors = result?.errors?.map((item) => stripAnsi(item.message ?? "")) ?? [];
    const trace = result?.attachments?.find((item) => item.name === "trace")?.path;
    if (options.exitCode === 0 && result?.status === "passed") {
        return { status: "passed", message: "The same user assertion passed.", trace };
    }
    if (
        options.exitCode === 1 &&
        result?.status === "failed" &&
        errors.length === 1 &&
        errors[0].split("\n")[0] === `Error: ${EXPECTATION_MARKER}` &&
        errors[0].includes("expect(") &&
        !/Target page, context or browser has been closed|Browser closed|browser has disconnected/i.test(errors[0])
    ) {
        return { status: "intended-failure", message: errors[0], trace };
    }
    return {
        status: "infrastructure-error",
        message:
            errors.join("\n") || "Playwright did not complete the single assertion. Inspect report and runner.log.",
        trace,
    };
}
async function checkedWorkspace(input: string): Promise<{ directory: string; hash: string }> {
    const directory = await realpath(input);
    for (const name of ["repro.spec.ts", "playwright.config.ts", "tsconfig.json", "package.json", "manifest.json"]) {
        const file = join(directory, name);
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_000_000) {
            throw new Error("Generated workspace files must be bounded ordinary files.");
        }
    }
    const source = await readFile(join(directory, "repro.spec.ts"), "utf8");
    const manifest = SafeJSON.parse(await readFile(join(directory, "manifest.json"), "utf8"), { strict: true }) as {
        testHash?: string;
    };
    const hash = testHash(source);
    const recording = await loadRecording(join(directory, "recording.json"));
    if (hash !== manifest.testHash || source !== generateRepro(recording)) {
        throw new Error(
            "Generated test changed since verification. Generate a new workspace to establish a new assertion."
        );
    }
    if ((await readFile(join(directory, "playwright.config.ts"), "utf8")) !== PLAYWRIGHT_CONFIG) {
        throw new Error("Workspace configuration changed. Imported executable configurations are never executed.");
    }
    if (
        (await readFile(join(directory, "tsconfig.json"), "utf8")) !==
        '{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","strict":true}}'
    ) {
        throw new Error("Generated TypeScript configuration changed; imported module aliases are never executed.");
    }
    const packageManifest: unknown = SafeJSON.parse(await readFile(join(directory, "package.json"), "utf8"), {
        strict: true,
    });
    const expectedManifest = {
        name: "bug-reproduction",
        private: true,
        scripts: { test: "playwright test" },
        devDependencies: { "@playwright/test": "1.62.1" },
    };
    if (
        SafeJSON.stringify(packageManifest, { strict: true }) !== SafeJSON.stringify(expectedManifest, { strict: true })
    ) {
        throw new Error("Generated package manifest changed. Imported package scripts are never executed or exported.");
    }
    return { directory, hash };
}
export async function inspectWorkspace(options: {
    directory: string;
    recording: BugRecording;
}): Promise<{ source: string; result?: VerificationResult }> {
    const { directory, hash } = await checkedWorkspace(options.directory);
    const source = await readFile(join(directory, "repro.spec.ts"), "utf8");
    if (source !== generateRepro(options.recording)) {
        throw new Error("Saved workspace does not match the reviewed recording. Generate a new workspace.");
    }
    const resultPath = join(directory, "verification.json");
    try {
        const result = SafeJSON.parse(await readFile(resultPath, "utf8"), { strict: true }) as VerificationResult;
        if (result.testHash === hash) {
            return { source, result };
        }
        log.warn({ directory }, "saved verification result has a stale test fingerprint");
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
        }
    }
    return { source };
}

async function checkedOutput(options: { directory: string; name: string; isDirectory?: boolean }): Promise<string> {
    const file = join(options.directory, options.name);
    try {
        const stat = await lstat(file);
        if (stat.isSymbolicLink() || (options.isDirectory ? !stat.isDirectory() : !stat.isFile())) {
            throw new Error("Workspace output paths must be ordinary files or directories, never symlinks.");
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
        }
    }
    return file;
}

async function writeOutput(options: { directory: string; name: string; content: string }): Promise<void> {
    const file = await checkedOutput(options);
    const handle = await open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600
    );
    try {
        await handle.writeFile(options.content);
    } finally {
        await handle.close();
    }
}

export async function verifyWorkspace(options: {
    directory: string;
    signal?: AbortSignal;
    baseUrl?: string;
    browserBinary?: string;
    timeoutMs?: number;
    onSpawn?: (pid: number) => void;
}): Promise<VerificationResult> {
    const { directory, hash } = await checkedWorkspace(options.directory);
    const started = Date.now();
    const runs = await checkedOutput({ directory, name: "runs", isDirectory: true });
    await checkedOutput({ directory, name: "runner.log" });
    await checkedOutput({ directory, name: "verification.json" });
    await mkdir(runs, { recursive: true });
    const runDirectory = join(runs, `${Date.now()}-${crypto.randomUUID()}`);
    await mkdir(runDirectory);
    const reportPath = join(runDirectory, "report.json");
    await Bun.write(reportPath, "{}");
    const modules = join(directory, "node_modules");
    try {
        await lstat(modules);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
        }
        await symlink(join(dependencyRoot, "node_modules"), modules, "dir");
    }
    const childEnv = env.getProcessEnv();
    if ((await realpath(modules)) !== (await realpath(join(dependencyRoot, "node_modules")))) {
        throw new Error(
            "Native execution only uses GenesisTools' installed Playwright dependencies. Imported dependencies are never executed."
        );
    }

    delete childEnv.BUG_TO_TEST_BASE_URL;
    delete childEnv.BUG_TO_TEST_BROWSER;
    childEnv.BUG_TO_TEST_RUN_DIR = runDirectory;
    if (options.baseUrl) {
        childEnv.BUG_TO_TEST_BASE_URL = options.baseUrl;
    }
    if (options.browserBinary) {
        childEnv.BUG_TO_TEST_BROWSER = options.browserBinary;
    }
    const cli = join(dependencyRoot, "node_modules", "playwright", "cli.js");
    log.info({ directory, cli }, "executing generated Playwright repro");
    let cancelled = options.signal?.aborted ?? false;
    let timedOut = false;
    const nodeBinary = Bun.which("node");
    if (!nodeBinary) {
        throw new Error("Playwright requires Node.js. Install Node.js and rerun this workspace.");
    }
    const processChild = spawn(
        nodeBinary,
        [
            cli,
            "test",
            "--config",
            join(directory, "playwright.config.ts"),
            "--tsconfig",
            join(directory, "tsconfig.json"),
        ],
        {
            cwd: directory,
            env: childEnv,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        }
    );
    if (processChild.pid) {
        options.onSpawn?.(processChild.pid);
    }
    let output = "";
    const append = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-100_000);
    };
    processChild.stdout?.on("data", append);
    processChild.stderr?.on("data", append);
    let termination: Promise<void> | undefined;
    const terminate = () => {
        if (termination) {
            return;
        }
        const pid = processChild.pid;
        if (!pid) {
            return;
        }
        const kill = (signal: NodeJS.Signals) => {
            try {
                if (process.platform === "win32") {
                    processChild.kill(signal);
                } else {
                    // pid-verified: detached process group created by this live owned child; never a stored PID.
                    process.kill(-pid, signal);
                }
            } catch (error) {
                log.debug({ error, pid }, "owned Playwright process group already exited");
            }
        };
        kill("SIGTERM");
        termination = new Promise<void>((accept) => {
            setTimeout(() => {
                kill("SIGKILL");
                accept();
            }, 1500);
        });
    };
    const abort = () => {
        cancelled = true;
        terminate();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
        () => {
            timedOut = true;
            terminate();
        },
        Math.min(60_000, Math.max(100, options.timeoutMs ?? 30_000))
    );
    if (options.signal?.aborted) {
        abort();
    }
    const exitCode = await new Promise<number>((accept, reject) => {
        processChild.once("error", reject);
        processChild.once("close", (code) => accept(code ?? -1));
    }).finally(async () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        await termination;
        if (termination && process.platform !== "win32" && processChild.pid) {
            const deadline = Date.now() + 1000;
            while (isProcessGroupAlive(processChild.pid)) {
                if (Date.now() >= deadline) {
                    throw new Error("Owned Playwright process group did not exit after forced termination.");
                }
                await Bun.sleep(Math.min(100, deadline - Date.now()));
            }
        }
    });
    await writeOutput({ directory, name: "runner.log", content: output });
    await Bun.write(join(runDirectory, "runner.log"), output);
    const report: unknown = SafeJSON.parse(await Bun.file(reportPath).text(), { strict: true });
    const classification = classifyReport({ report, exitCode });
    const result: VerificationResult = {
        ...classification,
        status: cancelled ? "cancelled" : timedOut ? "timed-out" : classification.status,
        message: cancelled
            ? "Cancelled. Owned Playwright children were terminated."
            : timedOut
              ? "Execution exceeded its deadline."
              : classification.message,
        testHash: hash,
        report: reportPath,
        durationMs: Date.now() - started,
        exitCode,
    };
    await writeOutput({
        directory,
        name: "verification.json",
        content: SafeJSON.stringify(result, { strict: true }, 2),
    });
    await Bun.write(join(runDirectory, "verification.json"), SafeJSON.stringify(result, { strict: true }, 2));
    log.info({ status: result.status, durationMs: result.durationMs }, "repro execution finished");
    return result;
}

export async function minimizeWorkspace(options: {
    recording: BugRecording;
    signal?: AbortSignal;
    browserBinary?: string;
    baseUrl?: string;
    onProgress?: (message: string) => void;
}): Promise<{ recording: BugRecording; directory: string; result: VerificationResult }> {
    const trigger = options.recording.actions.find(
        (item) => item.id === options.recording.triggerActionId && !item.excluded
    );
    if (!trigger) {
        throw new Error("Choose the recorded trigger action before minimizing; it will always be preserved.");
    }
    const initial = await generateWorkspace({ recording: options.recording });
    let result = await verifyWorkspace({ ...options, directory: initial });
    if (result.status !== "intended-failure") {
        throw new Error("Minimization requires a verified intended assertion failure first.");
    }
    let directory = initial;
    let recording = structuredClone(options.recording);
    const started = Date.now();
    let attempts = 0;
    for (const action of recording.actions.filter((item) => !item.excluded && item.id !== trigger.id)) {
        options.signal?.throwIfAborted();
        if (attempts >= 12 || Date.now() - started > 90_000) {
            break;
        }
        attempts++;
        const candidate = { ...recording, actions: recording.actions.filter((item) => item.id !== action.id) };
        options.onProgress?.(`Checking removal ${attempts}: ${action.kind}`);
        const candidateDirectory = await generateWorkspace({ recording: candidate });
        const candidateResult = await verifyWorkspace({ ...options, directory: candidateDirectory });
        if (candidateResult.status === "cancelled") {
            throw new Error("Minimization cancelled; original recording preserved.");
        }
        if (candidateResult.status === "intended-failure") {
            recording = candidate;
            recording.removedActionIds = [...(recording.removedActionIds ?? []), action.id];
            result = candidateResult;
            directory = candidateDirectory;
        }
    }
    return { recording: { ...recording, workspace: directory }, directory, result };
}
export async function exportWorkspace(options: {
    directory: string;
    destination: string;
    fixtures?: string[];
}): Promise<string> {
    const { directory: source } = await checkedWorkspace(options.directory);
    if ((options.fixtures?.length ?? 0) > 20) {
        throw new Error("Select at most 20 fixture files per bundle.");
    }
    const destination = resolve(options.destination);
    if (destination === source || destination.startsWith(`${source}/`)) {
        throw new Error("Choose a separate new export folder.");
    }
    await mkdir(destination, { recursive: false });
    for (const name of [
        "repro.spec.ts",
        "playwright.config.ts",
        "tsconfig.json",
        "package.json",
        "manifest.json",
        "recording.json",
        "README.md",
        "verification.json",
        "report.json",
        "runner.log",
        "test-results",
        "runs",
    ]) {
        const file = join(source, name);
        try {
            const stat = await lstat(file);
            if (stat.isSymbolicLink()) {
                throw new Error("Export refuses symlinked evidence.");
            }
            await cp(file, join(destination, name), { recursive: true, dereference: false });
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                throw error;
            }
        }
    }
    const rewritePaths = (value: unknown): unknown => {
        if (typeof value === "string" && value.startsWith(`${source}/`)) {
            return destination + value.slice(source.length);
        }
        if (Array.isArray(value)) {
            return value.map(rewritePaths);
        }
        if (value && typeof value === "object") {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewritePaths(item)]));
        }
        return value;
    };
    const rewriteReports = async (folder: string): Promise<void> => {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
            const file = join(folder, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error("Export refuses symlinked evidence.");
            }
            if (entry.isDirectory()) {
                await rewriteReports(file);
            } else if (["verification.json", "report.json"].includes(entry.name)) {
                const value: unknown = SafeJSON.parse(await readFile(file, "utf8"), { strict: true });
                await Bun.write(file, SafeJSON.stringify(rewritePaths(value), { strict: true }, 2));
            }
        }
    };
    await rewriteReports(destination);
    if (options.fixtures?.length) {
        await mkdir(join(destination, "fixtures"));
        for (const [index, fixture] of options.fixtures.entries()) {
            const stat = await lstat(fixture);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10_000_000) {
                throw new Error("Fixtures must be ordinary files up to 10 MB.");
            }
            await cp(fixture, join(destination, "fixtures", `${index + 1}-${fixture.split("/").at(-1)}`));
        }
    }
    await Bun.write(
        join(destination, "bundle-files.json"),
        SafeJSON.stringify(await readdir(destination), { strict: true }, 2)
    );
    return destination;
}
