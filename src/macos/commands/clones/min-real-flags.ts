import { BYTE_SIZE_FORMS } from "@app/macos/lib/clones/min-real";
import type { Command } from "commander";

/** `--min-real <size>` plus `--min-real-bytes|kilobytes|megabytes <n>`. None has a commander default: the
 *  caller resolves them with `resolveMinReal`, so passing an alias is never a conflict with a default value. */
export function addMinRealOptions(cmd: Command, description: string, defaultLabel?: string): Command {
    const suffix = defaultLabel === undefined ? "" : `; default ${defaultLabel}`;
    return cmd
        .option("--min-real <size>", `${description} (${BYTE_SIZE_FORMS}${suffix})`)
        .option("--min-real-bytes <n>", "--min-real as a whole number of bytes")
        .option("--min-real-kilobytes <n>", "--min-real in KB (1024 bytes)")
        .option("--min-real-megabytes <n>", "--min-real in MB (1024 KB)");
}
