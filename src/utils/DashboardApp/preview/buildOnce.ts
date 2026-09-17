#!/usr/bin/env bun
/**
 * One production build, then exit. The static serve mode spawns this instead of `vite build`
 * because a dashboard's Vite config loads the tool's server modules at config time, and the
 * handles they open keep the CLI process alive after the build has finished; a parent waiting
 * on its exit then waits forever. This runner exits itself the moment `build()` resolves.
 */
import { logger } from "@genesiscz/utils/logger";
import { build } from "vite";

const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const outDirIndex = args.indexOf("--out-dir");
const configFile = configIndex === -1 ? undefined : args[configIndex + 1];
const outDir = outDirIndex === -1 ? undefined : args[outDirIndex + 1];

if (!configFile || !outDir) {
    process.stderr.write("usage: buildOnce.ts --config <vite.config.ts> --out-dir <dir>\n");
    process.exit(2);
}

try {
    await build({ configFile, build: { outDir, emptyOutDir: true } });
    process.exit(0);
} catch (err) {
    logger.error({ err, configFile, outDir }, "static: one-off build failed");
    process.exit(1);
}
