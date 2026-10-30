import { spyOn } from "bun:test";
import { encodeRgbaToPng } from "@genesiscz/utils/image";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import type { AxResult } from "../runner";

/**
 * Test doubles for `tools control` (handoff h_00ddcbx1 t23): a scripted ax-tool, a commander harness
 * that captures what a command printed and how it exited, and generated PNGs. Nothing here reaches the
 * real window server; the real ax-tool refuses to run under the test runner anyway.
 */

/** A scripted native runner: every call is recorded, and `answer` decides what ax-tool would have said. */
export function fakeAx(answer: (args: string[], call: number) => AxResult = () => ({ ok: true })) {
    const calls: string[][] = [];
    const run = (args: string[]): AxResult => {
        calls.push([...args]);
        return answer(args, calls.length);
    };

    return { run, calls };
}

/** Thrown by the stubbed `process.exit`, so a command's exit ends the run without ending the test process. */
export class ExitSignal extends Error {
    constructor(readonly code: number) {
        super(`process.exit(${code})`);
    }
}

export interface CliRun {
    code: number;
    stdout: string[];
    errors: string[];
}

/** Runs one `tools control <args>` against a program the caller registered, and captures its output and exit. */
export async function runCli(register: (program: Command) => void, args: string[]): Promise<CliRun> {
    const program = new Command().exitOverride();
    register(program);
    const stdout: string[] = [];
    const errors: string[] = [];
    const spies = [
        spyOn(out, "println").mockImplementation((...parts: unknown[]) => {
            stdout.push(parts.map(String).join(" "));
        }),
        spyOn(out, "result").mockImplementation((value: unknown) => {
            stdout.push(typeof value === "string" ? value : SafeJSON.stringify(value));
        }),
        spyOn(logger, "error").mockImplementation((...parts: unknown[]) => {
            errors.push(parts.map(String).join(" "));
        }),
        spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
            throw new ExitSignal(Number(code ?? 0));
        }),
    ];
    const exitCode = process.exitCode;
    process.exitCode = 0;
    let code = 0;

    try {
        await program.parseAsync(args, { from: "user" });
        code = Number(process.exitCode ?? 0);
    } catch (error) {
        if (!(error instanceof ExitSignal)) {
            throw error;
        }

        code = error.code;
    } finally {
        for (const spy of spies) {
            spy.mockRestore();
        }

        process.exitCode = exitCode;
    }

    return { code, stdout, errors };
}

/** A solid PNG, optionally with one rectangle painted another colour: enough for pixel-diff gates. */
export function solidPng({
    width,
    height,
    color,
    patch,
}: {
    width: number;
    height: number;
    color: [number, number, number];
    patch?: { x: number; y: number; w: number; h: number; color: [number, number, number] };
}): Buffer {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const inPatch = patch && x >= patch.x && x < patch.x + patch.w && y >= patch.y && y < patch.y + patch.h;
            const [r, g, b] = inPatch ? patch.color : color;
            const offset = (y * width + x) * 4;
            data[offset] = r;
            data[offset + 1] = g;
            data[offset + 2] = b;
            data[offset + 3] = 255;
        }
    }

    return encodeRgbaToPng(data, width, height);
}
