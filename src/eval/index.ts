import { runTool } from "@genesiscz/utils/cli";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import type { EvalIo } from "@genesiscz/utils/eval-engine";
import { SystemClock } from "@genesiscz/utils/eval-engine/schedule";
import { out } from "@genesiscz/utils/logger";
import { createEvalHost } from "./lib/host";

if (import.meta.main) {
    await withInterrupt(async (signal) => {
        const io: EvalIo = {
            stdout: (text) => out.print(text),
            stderr: (text) => out.printErr(text),
            readStdin: async () => {
                const chunks: Buffer[] = [];
                for await (const chunk of process.stdin) {
                    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
                }

                return Buffer.concat(chunks).toString("utf8");
            },
            setExitCode: (code) => {
                process.exitCode = code;
            },
            exit: (code) => process.exit(code),
            clock: SystemClock,
            signal,
        };
        await runTool(createEvalHost(io), { tool: "eval" });
        await out.flush();
    });
}
