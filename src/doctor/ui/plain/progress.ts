import { formatBytes } from "@app/doctor/lib/size";
import type { EngineEvent } from "@app/doctor/lib/types";
import ora, { type Ora } from "ora";
import pc from "picocolors";

export interface ProgressDriver {
    onEvent(event: EngineEvent): void;
    dispose(): void;
}

export function createProgressDriver(analyzerNames: Map<string, string>): ProgressDriver {
    const spinners = new Map<string, Ora>();

    return {
        onEvent(event: EngineEvent): void {
            if (event.type === "analyzer-start") {
                const name = analyzerNames.get(event.analyzerId) ?? event.analyzerId;
                const spinner = ora({ text: `${pc.cyan(name)} - starting`, spinner: "dots" }).start();
                spinners.set(event.analyzerId, spinner);
                return;
            }

            if (event.type === "progress") {
                const spinner = spinners.get(event.analyzerId);
                if (!spinner) {
                    return;
                }

                const name = analyzerNames.get(event.analyzerId) ?? event.analyzerId;
                const percent = typeof event.percent === "number" ? ` ${event.percent.toFixed(0)}%` : "";
                const item = event.currentItem ? pc.dim(` ${event.currentItem}`) : "";
                const bytes = event.bytesFoundSoFar ? pc.dim(` - ${formatBytes(event.bytesFoundSoFar)}`) : "";
                spinner.text = `${pc.cyan(name)}${percent}${bytes}${item}`;
                return;
            }

            if (event.type === "analyzer-done") {
                const spinner = spinners.get(event.analyzerId);
                if (!spinner) {
                    return;
                }

                const name = analyzerNames.get(event.analyzerId) ?? event.analyzerId;
                const ms = `${event.durationMs}ms`;
                const count = `${event.findingsCount} findings`;

                if (event.error) {
                    spinner.fail(`${pc.red(name)} - ${pc.dim(ms)} - error`);
                } else {
                    spinner.succeed(`${pc.cyan(name)} - ${pc.dim(ms)} - ${count}`);
                }

                return;
            }

            if (event.type === "all-done") {
                return;
            }
        },

        dispose(): void {
            for (const spinner of spinners.values()) {
                if (spinner.isSpinning) {
                    spinner.stop();
                }
            }

            spinners.clear();
        },
    };
}
