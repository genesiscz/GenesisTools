import { SafeJSON } from "@app/utils/json";
import chalk from "chalk";
import type { FeedEvent } from "./types";

export function formatEventPretty(event: FeedEvent): string {
    const ts = event.ts.slice(11, 19);
    const seq = chalk.dim(`#${String(event.seq).padStart(4, "0")}`);
    const time = chalk.gray(ts);
    const tag = colorType(event.type);

    if (event.type === "registered") {
        const awaiting = event.awaiting_login ? chalk.yellow("(awaiting login)") : "";
        const idStr = event.agent_id ? chalk.cyan(event.agent_id) : chalk.dim("(no id)");
        const mainTag = event.is_main ? chalk.magenta("MAIN") : "";
        return `${time} ${seq} ${tag} ${chalk.bold(event.agent_name)} ${idStr} ${mainTag} ${awaiting}`;
    }

    if (event.type === "logged_in") {
        const modeTag = event.mode === "stream" ? chalk.green("stream") : chalk.blue("once");
        return `${time} ${seq} ${tag} ${chalk.bold(event.agent_name)} ${chalk.cyan(event.agent_id)} (${modeTag})`;
    }

    if (event.type === "logged_out") {
        return `${time} ${seq} ${tag} ${chalk.cyan(event.agent_id)} reason=${event.reason}`;
    }

    if (event.type === "stale_lock_reaped") {
        return `${time} ${seq} ${tag} ${chalk.yellow(event.lock)} pid=${event.pid}`;
    }

    if (event.type === "message") {
        const id = chalk.bold(`[${event.message_id}]`);
        const priv = event.private ? chalk.red("PRIVATE ") : "";

        if (event.in_reply_to) {
            if (!event.body) {
                return `${time} ${seq} ${tag} ${chalk.cyan(event.from_agent_name)} ack ${chalk.dim(event.in_reply_to)}`;
            }

            return `${time} ${seq} ${tag} ${id} ${priv}${chalk.cyan(event.from_agent_name)} → reply to ${chalk.dim(event.in_reply_to)}: ${event.body}`;
        }

        const recipients =
            event.to_agent_ids.length === 0 ? chalk.magenta("(broadcast)") : event.to_agent_ids.join(",");
        return `${time} ${seq} ${tag} ${id} ${priv}${chalk.cyan(event.from_agent_name)} → ${recipients}: ${event.body}`;
    }

    return `${time} ${seq} ${tag} ${SafeJSON.stringify(event, { strict: true })}`;
}

function colorType(type: string): string {
    switch (type) {
        case "message":
            return chalk.green(type);
        case "registered":
            return chalk.magenta(type);
        case "logged_in":
            return chalk.green(type);
        case "logged_out":
            return chalk.dim(type);
        case "stale_lock_reaped":
            return chalk.yellow(type);
        default:
            return chalk.gray(type);
    }
}
