import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Executor } from "@genesiscz/utils/cli/executor";

const executor = new Executor({ label: "music" });

export async function runAudio(command: string[]): Promise<{ stdout: string; stderr: string }> {
    const result = await executor.exec(command, {
        timeout: { ms: 300_000, reason: "offline music rendering or analysis of a track up to one hour" },
    });

    if (!result.success) {
        throw new Error(`${command[0]} exited ${result.exitCode}: ${result.stderr.slice(-4000)}`);
    }

    return result;
}

export async function fileHash(file: string): Promise<string> {
    const hash = createHash("sha256");

    for await (const chunk of createReadStream(file)) {
        hash.update(chunk);
    }

    return hash.digest("hex");
}

/** Only publishes a fully prepared file; link() atomically enforces no-overwrite. */
export async function publishAudio(options: {
    output: string;
    overwrite?: boolean;
    prepare: (temporary: string) => Promise<void>;
}): Promise<void> {
    const output = resolve(options.output);
    await mkdir(dirname(output), { recursive: true });
    const folder = await mkdtemp(join(dirname(output), ".music-"));
    const temporary = join(folder, "result");

    try {
        await options.prepare(temporary);

        if (options.overwrite) {
            await rename(temporary, output);
        } else {
            await link(temporary, output);
        }
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
}

export async function withMusicScratch<T>(run: (folder: string) => Promise<T>): Promise<T> {
    const folder = await mkdtemp(join(tmpdir(), "genesis-music-"));

    try {
        return await run(folder);
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
}
