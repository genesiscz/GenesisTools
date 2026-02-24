import logger from "@app/logger";
import { formatDuration, parseDuration } from "@app/utils/format";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

interface SleepOptions {
    after?: string;
}

export function registerSleepCommand(program: Command): void {
    const sleep = new Command("sleep");

    sleep
        .description("Put Mac to sleep, optionally after a delay")
        .option("--after <duration>", 'Delay before sleeping (e.g. "30m", "1h30m", "90s", "2hours")')
        .action(async (options: SleepOptions) => {
            try {
                await main(options);
            } catch (error) {
                process.stdout.write(`\r${" ".repeat(60)}\r`);
                const message = error instanceof Error ? error.message : String(error);
                logger.error(`Sleep command failed: ${message}`);
                p.log.error(message);
                process.exit(1);
            }
        });

    program.addCommand(sleep);
}

async function main(options: SleepOptions): Promise<void> {
    let delayMs = 0;

    if (options.after) {
        delayMs = parseDuration(options.after);

        if (delayMs <= 0) {
            p.log.error(`Invalid duration: "${options.after}"`);
            p.log.info("Examples: 30m, 1h, 1h30m, 90s, 45min, 2hours");
            process.exit(1);
        }
    }

    if (delayMs === 0) {
        p.log.step("Putting Mac to sleep now...");
        await execSleep();
        return;
    }

    const formatted = formatDuration(delayMs, "ms", "hm-smart");
    p.log.step(`Mac will sleep in ${pc.cyan(formatted)}`);

    const targetTime = new Date(Date.now() + delayMs);
    p.log.info(`Sleep scheduled for ${pc.dim(targetTime.toLocaleTimeString())}`);
    p.log.info(`${pc.dim("Press Ctrl+C to cancel")}`);

    await countdown(delayMs);
    await execSleep();
}

async function countdown(totalMs: number): Promise<void> {
    const endTime = Date.now() + totalMs;

    return new Promise((resolve) => {
        const interval = setInterval(() => {
            const remaining = endTime - Date.now();

            if (remaining <= 0) {
                clearInterval(interval);
                process.stdout.write(`\r${" ".repeat(60)}\r`);
                resolve();
                return;
            }

            const formatted = formatDuration(remaining, "ms", "hms");
            process.stdout.write(`\r  ${pc.yellow("⏳")} Sleeping in ${pc.bold(formatted)}...  `);
        }, 1000);

        process.on("SIGINT", () => {
            clearInterval(interval);
            process.stdout.write(`\r${" ".repeat(60)}\r`);
            p.log.warn("Sleep cancelled");
            process.exit(0);
        });
    });
}

async function execSleep(): Promise<void> {
    const proc = Bun.spawn({
        cmd: ["pmset", "sleepnow"],
        stdio: ["ignore", "pipe", "pipe"],
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
        logger.error(`pmset sleepnow failed: ${stderr}`);
        p.log.error("Failed to put Mac to sleep. You may need to run with sudo.");
        process.exit(1);
    }
}
