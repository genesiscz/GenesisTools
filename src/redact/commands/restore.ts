import { type RunRestoreArgs, runRestore } from "@app/redact/lib/run-restore";

export type RestoreCmdOptions = RunRestoreArgs;

export async function runRestoreCommand(options: RestoreCmdOptions): Promise<void> {
    await runRestore(options);
}
