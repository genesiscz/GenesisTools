#!/usr/bin/env bun

import { runTool } from "@genesiscz/utils/cli";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { formatBytes } from "@genesiscz/utils/format";
import { out } from "@genesiscz/utils/logger";
import { releaseDiskReserveIfFull } from "@genesiscz/utils/rm/disk-reserve";
import pc from "picocolors";
import { createRmProgram } from "./program";

if (import.meta.main) {
    // First, before any lock, request or ledger write: on a full disk those fail with ENOSPC.
    const reserve = releaseDiskReserveIfFull();

    if (reserve.action === "released") {
        out.printlnErr(
            pc.yellow(
                `The disk is nearly full (${formatBytes(reserve.free)} free): ${toolCommand("rm")} released its ` +
                    `${formatBytes(reserve.bytes)} reserve so it can record this run. The daily pass makes it again ` +
                    "once the disk has room."
            )
        );
    }

    await runTool(createRmProgram(), { tool: "rm" });
}
