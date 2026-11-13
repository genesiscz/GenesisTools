import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { MAX_INGEST_EVENTS } from "@genesiscz/utils/metrics/protocol";
import type { MetricsServiceClient } from "@genesiscz/utils/metrics/service-client";
import type { IngestResult } from "@genesiscz/utils/metrics/types";
import { LineBuffer, RpcPeer } from "@genesiscz/utils/rpc/peer";
import type { Command } from "commander";
import { withService } from "../lib/service";

const { log } = logger.scoped("metrics-connect");

/** Lines per `ingest` call from `--stdin`. */
const STDIN_BATCH = 1_000;

interface ConnectFlags {
    stdin?: boolean;
    rpc?: boolean;
}

/** Reads NDJSON events from stdin and sends them through `ingest` in batches; prints the counts at the end. */
async function connectStdin(client: MetricsServiceClient): Promise<void> {
    const lines = new LineBuffer();
    const total: IngestResult = { accepted: 0, rejected: 0, reasons: [] };
    let batch: unknown[] = [];
    /** The stdin line index of each event in `batch`, so a refusal names its line. */
    let lineOf: number[] = [];
    let seen = 0;

    const send = async (): Promise<void> => {
        if (batch.length === 0) {
            return;
        }

        const events = batch;
        const indexes = lineOf;
        batch = [];
        lineOf = [];
        const answer = await client.call("ingest", { events });
        total.accepted += answer.accepted;
        total.rejected += answer.rejected;

        for (const reason of answer.reasons) {
            if (total.reasons.length < 10) {
                total.reasons.push({ index: indexes[reason.index] ?? reason.index, reason: reason.reason });
            }
        }
    };

    const take = async (line: string): Promise<void> => {
        if (!line.trim()) {
            return;
        }

        seen += 1;

        try {
            batch.push(SafeJSON.parse(line, { strict: true }));
            lineOf.push(seen - 1);
        } catch (error) {
            total.rejected += 1;
            log.debug({ error, line: seen }, "a stdin line is no JSON");

            if (total.reasons.length < 10) {
                total.reasons.push({ index: seen - 1, reason: "no JSON" });
            }

            return;
        }

        if (batch.length >= Math.min(STDIN_BATCH, MAX_INGEST_EVENTS)) {
            await send();
        }
    };

    for await (const chunk of Bun.stdin.stream()) {
        for (const line of lines.push(chunk)) {
            await take(line);
        }
    }

    for (const line of lines.push(new TextEncoder().encode("\n"))) {
        await take(line);
    }

    await send();
    out.printlnErr(`Sent ${seen} lines: ${total.accepted} accepted, ${total.rejected} rejected`);
    out.result(total);
}

/**
 * Speaks JSON-RPC on stdin and stdout and forwards each request to the service, its answers and notifications back:
 * one pipe a long-lived producer holds open to ingest and to query.
 */
async function connectRpc(client: MetricsServiceClient): Promise<void> {
    const peer = new RpcPeer({
        write: (bytes) => {
            out.print(bytes.toString("utf8"));
            return bytes.length;
        },
        invalid: "answer",
        log,
        label: "metrics stdio",
        handle: async (incoming, context) =>
            client.socket.call(incoming.method, incoming.params, { signal: context.signal }),
    });
    const stopForwarding = client.socket.onNotification((notification) =>
        peer.notify(notification.method, notification.params)
    );

    for await (const chunk of Bun.stdin.stream()) {
        peer.receive(chunk);
    }

    await peer.queue;
    stopForwarding();
    peer.close("stdin ended");
}

async function connect(flags: ConnectFlags): Promise<void> {
    if (Boolean(flags.stdin) === Boolean(flags.rpc)) {
        out.printlnErr("Pass one of --stdin (NDJSON events in) or --rpc (JSON-RPC on stdio).");
        process.exitCode = 1;
        return;
    }

    await withService((client) => (flags.stdin ? connectStdin(client) : connectRpc(client)));
}

export function registerConnectCommand(program: Command): void {
    program
        .command("connect")
        .description(
            "Hold one pipe to the metrics service: --stdin sends NDJSON events through ingest in batches, --rpc forwards JSON-RPC requests on stdio (ingest, query, events, subscribe)"
        )
        .option("--stdin", "read one MetricEvent JSON per line and ingest them; prints accepted and rejected counts")
        .option("--rpc", "speak JSON-RPC 2.0 on stdin and stdout, one message per line")
        .action((flags: ConnectFlags) => connect(flags));
}
