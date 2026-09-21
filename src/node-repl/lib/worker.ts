import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import vm from "node:vm";
import { SafeJSON } from "@genesiscz/utils/json";
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

type Request = RunRequest | AddDirRequest;

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

/**
 * stdout carries the line protocol, so a bare console.log corrupts it: the parent cannot parse the
 * line, warns, drops it, and the turn still reports ok — the output is simply lost. Console output
 * belongs in the turn's text beside nodeRepl.write, and is mirrored to stderr so a live session
 * still sees it without a byte reaching the protocol channel.
 */
const consoleSink = console as unknown as Record<string, (...args: unknown[]) => void>;

for (const method of ["log", "info", "warn", "error", "debug", "trace", "dir"]) {
    consoleSink[method] = (...args: unknown[]): void => {
        const line = args.map((value) => (typeof value === "string" ? value : Bun.inspect(value))).join(" ");
        output.push(line);
        process.stderr.write(`${line}\n`);
    };
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
        output.push(typeof result === "string" ? result : Bun.inspect(result));
    }

    return output.join("\n");
}

/** An error thrown inside the vm context comes from that realm's Error, so instanceof is useless here. */
function describeError(error: unknown): { message: string; stack?: string } {
    const details: ErrorLike = typeof error === "object" && error !== null ? error : {};
    return {
        message: typeof details.message === "string" ? details.message : String(error),
        stack: typeof details.stack === "string" ? details.stack : undefined,
    };
}

async function handle(request: Request): Promise<Response> {
    output = [];
    images = [];

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
}

if (basename(process.argv[1] ?? "") === "worker.ts") {
    await main();
}
