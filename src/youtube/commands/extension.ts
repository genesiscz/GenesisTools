import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

export function registerExtensionCommand(program: Command): void {
    const cmd = program.command("extension").description("Build the YouTube Chrome extension");

    cmd.command("build")
        .description("Build the extension into dist/extension/")
        .action(async () => {
            await buildExtension();
        });
}

export async function buildExtension(): Promise<string> {
    const root = resolve(import.meta.dirname, "..", "extension");
    const dist = resolve(import.meta.dirname, "..", "..", "..", "dist", "extension");
    const proc = Bun.spawn(["bun", "--bun", "vite", "build", "-c", resolve(root, "vite.config.ts")], {
        stdio: ["inherit", "inherit", "inherit"],
    });
    const exit = await proc.exited;

    if (exit !== 0) {
        p.log.error(pc.red("Build failed"));
        process.exitCode = exit;
        throw new Error(`Extension build failed with exit code ${exit}`);
    }

    await mkdir(dist, { recursive: true });
    await copyFile(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
    await mkdir(resolve(dist, "icons"), { recursive: true });

    for (const name of ["icon16.png", "icon48.png", "icon128.png"]) {
        await copyFile(resolve(root, "icons", name), resolve(dist, "icons", name));
    }

    p.log.success(`Built to ${dist}. Load it via chrome://extensions → Developer Mode → Load unpacked.`);
    return dist;
}
