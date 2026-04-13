import { colorizeProvider } from "@ask/utils/helpers";
import * as p from "@clack/prompts";
import pc from "picocolors";

export interface AskUILoggerConfig {
    isTTY: boolean;
    modelPreSelected: boolean;
    raw: boolean;
    silent: boolean;
    showCost: boolean;
    outputFormat?: string;
}

function isStructuredOutput(format?: string): boolean {
    if (!format) {
        return false;
    }

    const lower = format.toLowerCase();
    return lower === "json" || lower === "jsonl";
}

export class AskUILogger {
    private readonly isTTY: boolean;
    private readonly suppressUI: boolean;
    private readonly showDiscovery: boolean;
    private readonly showProgress: boolean;
    private readonly costVisible: boolean;

    constructor(config: AskUILoggerConfig) {
        this.isTTY = config.isTTY;
        this.suppressUI = config.raw || config.silent || isStructuredOutput(config.outputFormat);
        this.showDiscovery = !this.suppressUI && (!config.modelPreSelected || config.isTTY);
        this.showProgress = !this.suppressUI && config.isTTY;
        this.costVisible = config.showCost && !this.suppressUI;
    }

    // ── Discovery logs ──────────────────────────────────────────────────

    logDetected({ provider, count }: { provider: string; count: number }): void {
        if (!this.showDiscovery) {
            return;
        }

        p.log.step(pc.dim(`Detected ${pc.cyan(provider)} provider with ${count} models`));
    }

    logDetectedSubscription({ provider, hint }: { provider: string; hint: string }): void {
        if (!this.showDiscovery) {
            return;
        }

        p.log.step(pc.dim(`Detected ${pc.cyan(provider)}${pc.dim(hint)} provider via subscription`));
    }

    logFetching({ source }: { source: string }): void {
        if (!this.showDiscovery) {
            return;
        }

        p.log.step(pc.dim(source));
    }

    // ── Progress logs ───────────────────────────────────────────────────

    logThinking(): void {
        if (!this.showProgress) {
            return;
        }

        p.log.step(pc.yellow("Thinking..."));
    }

    logUsing({
        provider,
        model,
        account,
    }: {
        provider: string;
        model: string;
        account?: { name: string; label?: string };
    }): void {
        if (!this.showProgress) {
            return;
        }

        let suffix = "";

        if (account) {
            suffix = account.label ? ` (${account.name}, ${account.label})` : ` (${account.name})`;
        }

        p.log.info(`Using ${colorizeProvider(provider)}/${model}${suffix}`);
    }

    logStarting({ provider, model }: { provider: string; model: string }): void {
        if (!this.showProgress) {
            return;
        }

        p.log.step(`Starting with ${colorizeProvider(provider)}/${model}`);
    }

    logTranscribing({ file, size }: { file: string; size: string }): void {
        if (!this.showProgress) {
            return;
        }

        p.log.step(pc.blue(`Transcribing ${file} (${size})`));
    }

    logResponseTime({ duration }: { duration: string }): void {
        if (!this.showProgress) {
            return;
        }

        console.log(pc.dim(`\nResponse time: ${duration}`));
    }

    logSessionSummary({ id, messages, duration }: { id: string; messages: number; duration: string }): void {
        if (!this.showProgress) {
            return;
        }

        p.log.info(pc.dim(`Session saved: ${id}`));
        p.log.info(pc.dim(`Messages: ${messages}`));
        p.log.info(pc.dim(`Duration: ${duration}`));
    }

    // ── Session chrome ──────────────────────────────────────────────────

    intro(): void {
        if (!this.showProgress) {
            return;
        }

        p.intro(pc.bgCyan(pc.black(" ASK ")));
    }

    outro({ message }: { message?: string } = {}): void {
        if (!this.isTTY) {
            return;
        }

        if (this.suppressUI) {
            console.log(message ?? "Goodbye!");
        } else {
            p.outro(pc.green(message ?? "Goodbye!"));
        }
    }

    // ── Cost visibility ─────────────────────────────────────────────────

    shouldShowCost(): boolean {
        return this.costVisible;
    }
}

// ── Singleton ───────────────────────────────────────────────────────────

const NO_OP_LOGGER = new AskUILogger({
    isTTY: false,
    modelPreSelected: true,
    raw: true,
    silent: true,
    showCost: false,
});

let _instance: AskUILogger | null = null;

export function initAskUI(config: AskUILoggerConfig): AskUILogger {
    _instance = new AskUILogger(config);
    return _instance;
}

export function askUI(): AskUILogger {
    return _instance ?? NO_OP_LOGGER;
}
