#!/usr/bin/env bun

import { registerAiProxyRefScanner } from "@app/ai-proxy/lib/account-refs";
import { loadConfigFresh } from "@app/ai-proxy/lib/config";
import { setProxyUsageSink } from "@app/ai-proxy/lib/usage/usage-events";
import { AI_PROXY_REGISTRARS } from "@app/ai-proxy/registrars";
import { recordUsage } from "@genesiscz/utils/ai/usage";
import { runTool } from "@genesiscz/utils/cli";
import { configureLogger } from "@genesiscz/utils/logger";
import { Command } from "commander";

// proxy.log is the serve process's stderr — without timestamps a stale log
// file is indistinguishable from a quiet one, which is exactly how a 5-day-old
// proxy.log derailed an incident investigation. Must run before runTool: its
// setBaseBinding() instantiates the logger, freezing timestamp options.
if (process.argv.includes("serve")) {
    configureLogger({ includeTimestamp: true, timestampFormat: "SYS:yyyy-mm-dd HH:MM:ss" });
}

// So `referrersOf` sees the accounts this proxy bills. The scanner is per
// PROCESS, so `tools ai config link` needs the same one line in its own
// entrypoint to see proxy links (src/ai/ is another phase's file).
registerAiProxyRefScanner(loadConfigFresh);

// Mirror the ledger's bookings into the shared usage layer. `recordUsage` never
// throws, so a failure here cannot break a proxied request. A booked cost is
// stored verbatim (the invoicing table is a deliberate carve-out and its rates
// may differ from the catalog's); an unpriced row gets a catalog estimate
// tagged `costSource: "catalog"`, which keeps "the invoicing table did not know
// this model" answerable instead of hiding it behind a list price.
setProxyUsageSink((event) => void recordUsage(event));

const program = new Command()
    .name("ai-proxy")
    .description("OpenAI-compatible local proxy for Grok, GitHub Copilot, and other AI providers")
    .version("0.1.0");

await runTool(program, { tool: "ai-proxy", registrars: AI_PROXY_REGISTRARS });
