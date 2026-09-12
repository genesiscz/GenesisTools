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

function resolveSpecifier(specifier: string): string {
    if (
        specifier.startsWith("node:") ||
        specifier.startsWith("/") ||
        specifier.startsWith(".") ||
        specifier.startsWith("data:") ||
        specifier.startsWith("file:")
    ) {
        return specifier;
    }

    for (const dir of moduleDirs) {
        try {
            return Bun.resolveSync(specifier, dir);
        } catch {
            // not in this directory; the next one, then the server's own resolution
        }
    }

    return specifier;
}

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

async function runTurn(code: string): Promise<Response["text"]> {
    const script = new vm.Script(rewriteTurn(code), {
        filename: "repl-turn.js",
        importModuleDynamically: (async (specifier: string) => {
            if (!importAllowed(specifier, policy, moduleDirs)) {
                throw new Error(`import of "${specifier}" is not allowed by ${policy.source}`);
            }

            return import(resolveSpecifier(specifier));
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

async function main(): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = "";

    for await (const chunk of Bun.stdin.stream()) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf("\n");

        while (newline >= 0) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);

            if (line) {
                const request = SafeJSON.parse(line, { strict: true }) as Request;
                const response = await handle(request);
                process.stdout.write(`${SafeJSON.stringify(response)}\n`);
            }

            newline = buffered.indexOf("\n");
        }
    }
}

if (basename(process.argv[1] ?? "") === "worker.ts") {
    await main();
}
