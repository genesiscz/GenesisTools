import { paths } from "@app/dev-dashboard/contract/endpoints";
import { logger } from "@app/logger";
import { printLn } from "@app/utils/cli";
import type { Command } from "commander";
import { getJson, postJson, resolveBaseUrl } from "../lib/client";
import { readLocalOperator, sanitizeOperator, writeLocalOperator } from "../lib/operator";

export function registerOperatorCommand(program: Command): void {
    program
        .command("operator [name]")
        .description("Show or set the operator identity attributed to your board writes")
        .option("--base <url>", "dev-dashboard base URL")
        .action(async (name: string | undefined, opts: { base?: string }) => {
            const base = resolveBaseUrl(opts.base);

            if (name === undefined) {
                const local = await readLocalOperator();
                let serverDefault = "";
                try {
                    serverDefault = (await getJson<{ operator: string }>(base, paths.boardsOperator())).operator;
                } catch (err) {
                    logger.debug({ base, err }, "boards operator: server fetch failed");
                }
                await printLn(`local:          ${local || "(unset)"}`);
                await printLn(`server default: ${serverDefault || "(unset)"}`);
                return;
            }

            const clean = sanitizeOperator(name);
            if (!clean) {
                process.stderr.write("operator name is empty after sanitization\n");
                process.exitCode = 1;
                return;
            }

            await writeLocalOperator(clean);
            try {
                await postJson(base, paths.boardsOperator(), { payload: { operator: clean }, method: "PUT" });
            } catch (err) {
                logger.debug({ base, err }, "boards operator: server PUT failed");
                await printLn(`operator set locally to ${clean} (server unreachable — local only)`);
                return;
            }
            await printLn(`operator set to ${clean}`);
        });
}
