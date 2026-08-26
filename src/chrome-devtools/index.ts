#!/usr/bin/env bun
/**
 * tools chrome-devtools — drive a REAL running browser (Brave/Chrome) over the
 * Chrome DevTools Protocol. The debugging harness for bugs that only exist in
 * the user's own browser: auth loops, cookie poison, stuck SPAs, CORS.
 *
 *   attach       discover endpoints, start the background recorder, print next steps
 *   record       the capture engine (one per port, rolling 4h buffer)
 *   follow       live view over the buffer (channels + Monitor hints)
 *   har          DevTools-grade HAR — retroactive from the buffer, or a live window
 *   status       recorders, CPU/memory, buffers, endpoints
 *   doctor       read-only diagnosis · cleanup — the mutating counterpart
 *   cookies, console, eval, nav, shot, grid, trace, targets, rm-cookie
 *   open, restart — launch/relaunch a browser WITH the debugging flag
 *   scaffold, cheatsheet, mcp — scripting doors
 */
import { runTool } from "@genesiscz/utils/cli";
import { Command } from "commander";
import { registerAttach } from "./commands/attach.ts";
import { registerBrowse } from "./commands/browse.ts";
import { registerCleanup } from "./commands/cleanup.ts";
import { registerDoctor } from "./commands/doctor.ts";
import { registerFollow } from "./commands/follow.ts";
import { registerHar } from "./commands/har.ts";
import { registerInspect } from "./commands/inspect.ts";
import { registerRecord, registerWatchTombstone } from "./commands/record.ts";
import { registerScripting } from "./commands/scripting.ts";
import { registerStatus } from "./commands/status.ts";

const program = new Command();
program
    .name("tools chrome-devtools")
    .description("drive a real running browser over CDP — attach, record, follow, HAR, cookies, doctor")
    .showHelpAfterError()
    .addHelpText(
        "after",
        `
Non-negotiable first fact: --remote-debugging-port is parsed at browser
STARTUP. It cannot be enabled on a running browser. 'attach' tells you
exactly what to restart when nothing listens — ask the user before quitting
their browser.

Start here, every time:
  tools chrome-devtools attach

Do NOT pipe 'record', 'follow' or 'trace' to head/tail — they are long-running
and print their pid + output paths first. The capture segments under
/tmp/GenesisTools/ChromeDevtools/<port>/ are internal: never tail them raw
(rotation breaks the fd) — 'follow' is the live view, 'har' the dump.`
    );

registerAttach(program);
registerRecord(program);
registerWatchTombstone(program);
registerFollow(program);
registerHar(program);
registerStatus(program);
registerDoctor(program);
registerCleanup(program);
registerBrowse(program);
registerInspect(program);
registerScripting(program);

await runTool(program, { tool: "chrome-devtools" });
