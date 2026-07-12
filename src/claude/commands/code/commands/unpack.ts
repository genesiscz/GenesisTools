import { join } from "node:path";
import { out } from "@app/logger";
import { ensureBeautified, ensureBundle, ensureNormalized } from "../lib/bundle";

export interface UnpackOptions {
    platform?: string;
    beautified: boolean;
    normalized: boolean;
    force: boolean;
}

export async function unpackCommand(version: string, opts: UnpackOptions): Promise<void> {
    const ref = await ensureBundle({ version, platform: opts.platform, force: opts.force });
    out.log.info(
        `source: ${ref.meta.source}, modules: ${ref.meta.modules.length}, entry ${ref.meta.modules.find((m) => m.file === ref.meta.entrypoint)?.bytes} bytes`
    );
    out.println(ref.entrypointPath);

    if (opts.beautified || opts.normalized) {
        await ensureBeautified(ref);
        out.println(join(ref.dir, "beautified.js"));
    }

    if (opts.normalized) {
        await ensureNormalized(ref);
        out.println(join(ref.dir, "normalized.js"));
    }
}
