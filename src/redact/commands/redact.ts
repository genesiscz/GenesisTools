import { type RunRedactArgs, runRedact } from "@app/redact/lib/run-redact";

export type RedactCmdOptions = RunRedactArgs;

export async function runRedactCommand(options: RedactCmdOptions): Promise<void> {
    await runRedact(options);
}
