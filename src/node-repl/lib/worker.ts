import { Console } from "node:console";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Writable } from "node:stream";
import vm from "node:vm";
import { SafeJSON } from "@genesiscz/utils/json";
import { describeMethod, searchMethods } from "@genesiscz/utils/repl/discovery";
import { readShowable, type ShowInput } from "@genesiscz/utils/repl/show";
import type { ReplToolset, ToolsetContext } from "@genesiscz/utils/repl/toolset";
import { rewriteTurn } from "./rewrite";
import { type ImportPolicy, importAllowed, loadImportPolicy } from "./trust";

/**
 * The REPL's persistent scope is this process's own global scope, in a child of the MCP
 * server. The process boundary is the sandbox and the timeout: a turn that starves its own
 * event loop with an endless chain of awaits defeats every in-process timer, so the parent
 * kills this process on the wall clock and spawns a new one. A separate vm context would add
 * nothing but a second realm, whose objects Bun.inspect prints with their prototype spelled
 * out. Protocol: one JSON object per line on stdin, one per line on stdout.
 */

interface RunRequest {
    id: number;
    op: "run";
    code: string;
}

interface AddDirRequest {
    id: number;
    op: "addDir";
    dir: string;
}

interface PreloadRequest {
    id: number;
    op: "preload";
    toolsets: string[];
    scratchDir: string;
}

interface DisposeRequest {
    id: number;
    op: "dispose";
}

type Request = RunRequest | AddDirRequest | PreloadRequest | DisposeRequest;

interface EmittedImage {
    mimeType: string;
    data: string;
    path: string;
}

interface ErrorLike {
    message?: unknown;
    stack?: unknown;
}

interface Response {
    id: number;
    ok: boolean;
    text: string;
    images: EmittedImage[];
    error?: string;
    stack?: string;
}

const moduleDirs: string[] = [];
const policy: ImportPolicy = loadImportPolicy();
const imageDir = mkdtempSync(join(tmpdir(), "node-repl-images-"));
let output: string[] = [];
let images: EmittedImage[] = [];
let imageCounter = 0;

declare global {
    var nodeRepl: typeof replApi;
    var help: (name?: string) => string;
    var search: (query: string) => string;
    var describe: (name: string) => string;
    var show: (input: ShowInput | ShowInput[]) => Promise<void>;
    var sleep: (ms: number) => Promise<void>;
}

const replApi = {
    write(value: unknown): void {
        output.push(typeof value === "string" ? value : Bun.inspect(value));
    },
    async emitImage(input: { bytes: Uint8Array | string; mimeType: string }): Promise<void> {
        const bytes = typeof input.bytes === "string" ? Buffer.from(input.bytes, "base64") : Buffer.from(input.bytes);
        const extension = input.mimeType.split("/")[1]?.split("+")[0] ?? "bin";
        const path = join(imageDir, `image-${++imageCounter}.${extension}`);
        writeFileSync(path, bytes);
        images.push({ mimeType: input.mimeType, data: bytes.toString("base64"), path });
    },
    cwd: process.cwd(),
    homeDir: homedir(),
    tmpDir: tmpdir(),
};

globalThis.nodeRepl = replApi;

const toolsets: ReplToolset[] = [];

async function showImages(input: ShowInput | ShowInput[]): Promise<void> {
    for (const one of Array.isArray(input) ? input : [input]) {
        const image = await readShowable(one);
        await replApi.emitImage({ bytes: image.bytes, mimeType: image.mimeType });
    }
}

const CORE_HELP = [
    "search(query) finds methods across loaded toolsets; describe(name) prints a method's complete descriptor.",
    "help(name?) prints the docs of a loaded toolset; show(image | path | Buffer) returns an image to the model.",
    "nodeRepl.write(value) adds output; nodeRepl.emitImage({ bytes, mimeType }) is show() without the type check; await sleep(ms) waits.",
    "Each method says what it does: [read] changes nothing and reaches no one; [reversible] or [destructive] change state; · user means the user meets it (a dialog, a window, focus, the clipboard, the inbox), · paid means a run billed to an account. A call that would reach someone it does not declare is refused.",
];

function helpText(name?: string): string {
    if (name === undefined) {
        // Each loaded toolset with the call that prints its methods, so a bare help() is never a dead end.
        const loaded = toolsets.map((toolset) => `${toolset.oneLine()} help("${toolset.id}") lists its methods.`);
        return [...CORE_HELP, ...(loaded.length > 0 ? loaded : ["No toolsets are loaded (--toolset a,b)."])].join("\n");
    }

    const toolset = toolsets.find((one) => one.id === name || one.api.global === name);

    if (!toolset) {
        throw new Error(
            `No toolset "${name}" is loaded; loaded: ${toolsets.map((one) => one.id).join(", ") || "none"}`
        );
    }

    return toolset.docs();
}

globalThis.help = helpText;
globalThis.search = (query) =>
    searchMethods(
        toolsets.map((one) => one.api),
        query
    );
globalThis.describe = (name) =>
    describeMethod(
        toolsets.map((one) => one.api),
        name
    );
globalThis.show = showImages;
globalThis.sleep = (ms: number) => Bun.sleep(ms);

let recordingRequestId = 0;
const recordingRequests = new Map<number, { resolve(id: string): void; reject(error: Error): void }>();
process.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null || !("id" in message) || typeof message.id !== "number") {
        return;
    }

    const pending = recordingRequests.get(message.id);

    if (!pending) {
        return;
    }

    recordingRequests.delete(message.id);

    if ("recordingId" in message && typeof message.recordingId === "string") {
        pending.resolve(message.recordingId);
    } else {
        pending.reject(new Error("error" in message ? String(message.error) : "Recording start failed"));
    }
});

function startHostedRecording(options: unknown): Promise<string> {
    return new Promise((resolve, reject) => {
        const id = ++recordingRequestId;
        // The parent owns the startup deadline and replies with either the recording or the timeout error.
        recordingRequests.set(id, { resolve, reject });
        try {
            if (!process.send) {
                throw new Error("Recording startup requires a parent IPC connection");
            }
            process.send({ id, recordingStart: options });
        } catch (error) {
            recordingRequests.delete(id);
            reject(error);
        }
    });
}

async function preload(request: PreloadRequest): Promise<string> {
    const { createToolsets } = await import("./toolsets");
    const ctx: ToolsetContext = {
        scratchDir: request.scratchDir,
        show: showImages,
        write: replApi.write,
        recorder: { start: startHostedRecording },
    };

    for (const toolset of await createToolsets(request.toolsets)) {
        Object.assign(globalThis, await toolset.load(ctx));
        toolsets.push(toolset);
    }

    return `toolsets preloaded: ${toolsets.map((toolset) => toolset.id).join(", ")}`;
}

async function disposeToolsets(): Promise<string[]> {
    const failures: string[] = [];

    for (const toolset of toolsets.splice(0).reverse()) {
        try {
            await toolset.dispose();
        } catch (error) {
            failures.push(`${toolset.id}: ${describeError(error).message}`);
        }
    }

    return failures;
}

/**
 * stdout carries the line protocol, so a bare console.log corrupts it: the parent cannot parse the
 * line, warns, drops it, and the turn still reports ok — the output is simply lost. Console output
 * belongs in the turn's text beside nodeRepl.write, and is mirrored to stderr so a live session
 * still sees it without a byte reaching the protocol channel.
 *
 * The WHOLE console is routed, not a list of methods. Replacing seven by name left `table`,
 * `count`, `timeEnd`, `timeLog` and the `group` label writing to stdout, which is the same silent
 * loss. A Console built on the turn's own stream keeps every method's native formatting, and its
 * write runs synchronously, so a line is in `output` before the next statement runs.
 *
 * Colour stays off: the turn text is data for the caller, not a terminal, and the default
 * `colorMode: "auto"` paints inspected values whenever FORCE_COLOR is set in the environment.
 */
const turnStream = new Writable({
    write(chunk: Buffer | string, _encoding, done): void {
        const text = String(chunk).replace(/\n$/, "");

        output.push(text);
        process.stderr.write(`${text}\n`);
        done();
    },
});
const turnConsole = new Console({ stdout: turnStream, stderr: turnStream, colorMode: false });
const turnMethods = new Set([
    ...Object.keys(turnConsole),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(turnConsole)),
]);
const globalConsole = console as unknown as Record<string, unknown>;
const capturedConsole = turnConsole as unknown as Record<string, unknown>;

for (const name of turnMethods) {
    const method = capturedConsole[name];

    if (name !== "constructor" && typeof method === "function") {
        globalConsole[name] = method.bind(turnConsole);
    }
}

async function runTurn(code: string): Promise<Response["text"]> {
    const script = new vm.Script(rewriteTurn(code), {
        filename: "repl-turn.js",
        importModuleDynamically: (async (specifier: string) => {
            const decision = importAllowed(specifier, policy, moduleDirs);

            if (!decision.allowed) {
                throw new Error(`import of "${specifier}" is not allowed by ${policy.source}`);
            }

            // The authorized path, never a second resolution: re-resolving by directory order
            // could load a different file from the one the containment check approved.
            return import(decision.resolved ?? specifier);
        }) as never,
    });
    const result = await script.runInThisContext();

    if (result !== undefined) {
        const text = typeof result === "string" ? result : Bun.inspect(result);
        output.push(text);

        // A call that returns a Promise inside an object or array prints as `Promise { … }`, which reads as a value.
        if (typeof result !== "string" && /\bPromise \{/.test(text)) {
            output.push("note: the result holds a Promise; `await` the call that made it to see its value");
        }
    }

    return output.join("\n");
}

/** Frames of the kernel itself (this worker, the vm call, the toolset argument check), which say nothing about the turn. */
const KERNEL_FRAME =
    /node-repl[/\\]lib[/\\]worker\.ts|utils[/\\]repl[/\\]toolset\.ts|runInThisContext|processTicksAndRejections/;
/** The script's own top level, which only calls the turn's wrapper. */
const WRAPPER_FRAME = /^\s+at repl-turn\.js:\d+:\d+$/;
/** `(async () => {` puts the turn one line below where its author wrote it. */
const TURN_FRAME = /repl-turn\.js:(\d+)/g;

/** The stack as the turn's author reads it: kernel frames dropped, turn lines numbered as written. */
export function turnStack(stack: string): string {
    return stack
        .split("\n")
        .filter((line) => !(/^\s+at /.test(line) && KERNEL_FRAME.test(line)) && !WRAPPER_FRAME.test(line))
        .map((line) =>
            /^\s+at /.test(line)
                ? line.replace(TURN_FRAME, (_, row: string) => `turn:${Math.max(1, Number(row) - 1)}`)
                : line
        )
        .join("\n");
}

/** An error thrown inside the vm context comes from that realm's Error, so instanceof is useless here. */
function describeError(error: unknown): { message: string; stack?: string } {
    const details: ErrorLike = typeof error === "object" && error !== null ? error : {};
    return {
        message: typeof details.message === "string" ? details.message : String(error),
        stack: typeof details.stack === "string" ? turnStack(details.stack) : undefined,
    };
}

async function handle(request: Request): Promise<Response> {
    output = [];
    images = [];

    if (request.op === "preload") {
        try {
            return { id: request.id, ok: true, text: await preload(request), images };
        } catch (error) {
            const { message, stack } = describeError(error);
            return { id: request.id, ok: false, text: output.join("\n"), images, error: message, stack };
        }
    }

    if (request.op === "dispose") {
        const failures = await disposeToolsets();
        return failures.length > 0
            ? { id: request.id, ok: false, text: "", images: [], error: failures.join("; ") }
            : { id: request.id, ok: true, text: "toolsets disposed", images: [] };
    }

    if (request.op === "addDir") {
        if (!moduleDirs.includes(request.dir)) {
            moduleDirs.push(request.dir);
        }

        return { id: request.id, ok: true, text: `module directory registered: ${request.dir}`, images: [] };
    }

    try {
        const text = await runTurn(request.code);
        return { id: request.id, ok: true, text, images };
    } catch (error) {
        const { message, stack } = describeError(error);
        return { id: request.id, ok: false, text: output.join("\n"), images, error: message, stack };
    }
}

/**
 * One stdin line becomes a Request, or the Response that says why it could not. Throwing here
 * would kill the worker over a single malformed line, and the parent — which has no way to tell
 * a dead worker from a slow turn — would then burn the whole wall clock before reporting it.
 */
function readRequest(line: string): { request: Request } | { failure: Response } {
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(line, { strict: true });
    } catch (error) {
        const { message } = describeError(error);
        return { failure: { id: 0, ok: false, text: "", images: [], error: `stdin line is not JSON: ${message}` } };
    }

    const fields = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const id = typeof fields.id === "number" ? fields.id : 0;

    if (fields.op === "run" && typeof fields.code === "string") {
        return { request: { id, op: "run", code: fields.code } };
    }

    if (fields.op === "addDir" && typeof fields.dir === "string") {
        return { request: { id, op: "addDir", dir: fields.dir } };
    }

    if (
        fields.op === "preload" &&
        Array.isArray(fields.toolsets) &&
        fields.toolsets.every((one) => typeof one === "string") &&
        typeof fields.scratchDir === "string"
    ) {
        return { request: { id, op: "preload", toolsets: fields.toolsets, scratchDir: fields.scratchDir } };
    }

    if (fields.op === "dispose") {
        return { request: { id, op: "dispose" } };
    }

    return { failure: { id, ok: false, text: "", images: [], error: `unsupported request: ${line.slice(0, 200)}` } };
}

async function main(): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = "";

    for await (const chunk of Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf("\n");

        while (newline >= 0) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);

            if (line) {
                const read = readRequest(line);
                const response = "request" in read ? await handle(read.request) : read.failure;
                process.stdout.write(`${SafeJSON.stringify(response)}\n`);
            }

            newline = buffered.indexOf("\n");
        }
    }

    // The parent closed stdin: it is stopping without a dispose request, so release the toolsets here.
    const failures = await disposeToolsets();

    if (failures.length > 0) {
        process.stderr.write(`toolset dispose failed: ${failures.join("; ")}\n`);
    }
}

if (basename(process.argv[1] ?? "") === "worker.ts") {
    await main();
}
