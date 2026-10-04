import { logger, out } from "@genesiscz/utils/logger";
import { buildNativeOnce, swiftReleaseBuild } from "./native-build";

/**
 * `ensureBinary` is synchronous, and so are the `runAx` calls behind it, while the cross-process
 * build lock is async. It runs this file as a child and blocks on it, so the waiting happens here.
 *
 * argv: `<binary> <sourceDir> <lockPath>`. stdout: one JSON object, `{ ok: true, built }` or
 * `{ ok: false, error }`. Progress goes to stderr through the logger.
 */
async function main(): Promise<void> {
    const [binary, sourceDir, lockPath] = process.argv.slice(2);

    if (!binary || !sourceDir || !lockPath) {
        out.result({ ok: false, error: "usage: <binary> <sourceDir> <lockPath>" });
        process.exitCode = 2;
        return;
    }

    try {
        const { built } = await buildNativeOnce({
            binary,
            sourceDir,
            lockPath,
            build: () => swiftReleaseBuild(sourceDir),
        });
        out.result({ ok: true, built });
    } catch (error) {
        logger.debug({ error, sourceDir }, "native build worker failed");
        out.result({ ok: false, error: error instanceof Error ? error.message : String(error) });
        process.exitCode = 1;
    }
}

if (import.meta.main) {
    await main();
}
