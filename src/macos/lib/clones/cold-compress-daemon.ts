import { execTool } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";

/** The transparent command owns the battery guard, config age limit, lsof,
 * byte verification, recovery, and its existing compression ledger. */
export async function runColdCompressTask(options: { paths?: string[] } = {}): Promise<void> {
    const targets = options.paths?.length ? options.paths : ["--preset", "agents"];
    const result = await execTool(["compress", "transparent", "apply", ...targets], {
        timeout: 30 * 60_000,
    });

    if (result.stdout) {
        out.print(result.stdout);
    }

    if (result.exitCode !== 0) {
        throw new Error(`Transparent compression exited ${result.exitCode}: ${result.stderr}`);
    }
}

if (import.meta.main) {
    runColdCompressTask({ paths: process.argv.slice(2) }).catch((error) => {
        logger.error({ error }, "du cold compression task failed");
        process.exitCode = 1;
    });
}
