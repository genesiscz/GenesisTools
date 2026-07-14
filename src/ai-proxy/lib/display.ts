import { isProviderImplemented } from "@app/ai-proxy/lib/providers/registry";
import type { AiProxyAccountConfig, ProxyModelMeta } from "@app/ai-proxy/lib/types";
import { out } from "@app/logger";
import { suggestCommand } from "@app/utils/cli";
import { formatTokens } from "@app/utils/format";
import {
    createBoxTable,
    formatDotStatus,
    renderCliHeader,
    renderCliKeyRow,
    renderCliSection,
    truncateDisplay,
} from "@app/utils/table";
import pc from "picocolors";

function formatVisibility(visibility: string): string {
    switch (visibility) {
        case "high":
            return pc.green("high");
        case "medium":
            return pc.yellow("medium");
        case "low":
            return pc.dim("low");
        default:
            return pc.dim(visibility);
    }
}

function formatSpeed(speed: string): string {
    switch (speed) {
        case "fast":
            return pc.green("fast");
        case "slow":
            return pc.yellow("slow");
        case "medium":
            return pc.white("medium");
        default:
            return pc.dim(speed);
    }
}

function formatThinking(thinking: string): string {
    switch (thinking) {
        case "reasoning":
            return pc.magenta("reasoning");
        case "multi-agent":
            return pc.cyan("multi-agent");
        case "optional":
            return pc.yellow("optional");
        case "none":
            return pc.dim("none");
        default:
            return pc.dim(thinking);
    }
}

/**
 * Grok (and live xAI) catalogs can carry a live probe result.
 * Claude/Codex never probe — they show n/a (not a failure).
 */
function formatProbeStatus(status: string | undefined): string {
    if (status === "ok") {
        return formatDotStatus("ok", "ok");
    }

    if (status === "fail") {
        return formatDotStatus("err", "fail");
    }

    if (status === "skipped") {
        return formatDotStatus("warn", "skip");
    }

    return pc.dim("n/a");
}

function formatContextWindow(tokens: number | undefined): string {
    if (tokens == null) {
        return pc.dim("—");
    }

    return pc.white(formatTokens(tokens));
}

function formatEnabled(enabled: boolean): string {
    if (enabled) {
        return formatDotStatus("ok", "yes");
    }

    return formatDotStatus("err", "no");
}

export interface AccountListRow {
    account: AiProxyAccountConfig;
    modelCount: number;
}

function accountNote(account: AiProxyAccountConfig, modelCount: number): string {
    if (!account.enabled) {
        return "disabled in config";
    }

    if (!isProviderImplemented(account.provider)) {
        return "provider not wired for catalog/runtime yet";
    }

    if (modelCount === 0) {
        if (account.provider === "xai-api-key") {
            return "no models (check API key / GET /models)";
        }

        return "enabled but catalog empty";
    }

    return "—";
}

function cmd(replaceCommand: string[]): string {
    return suggestCommand("tools ai-proxy", { replaceCommand });
}

export function displayModelsTable(models: ProxyModelMeta[]): void {
    renderCliHeader("Proxy Models", "ids Cursor / clients can call");

    if (models.length === 0) {
        out.println(pc.dim("  No models in catalog.\n"));
        out.println(
            `${pc.dim("  Next: ")}${pc.cyan(cmd(["accounts", "list"]))}${pc.dim("  ·  ")}${pc.cyan(cmd(["config", "detect"]))}`
        );
        out.println();
        return;
    }

    const table = createBoxTable(["PROXY ID", "VIS", "SPEED", "THINK", "CTX", "PROBE"]);

    for (const model of models) {
        table.push([
            pc.white(model.proxyId),
            formatVisibility(model.visibility),
            formatSpeed(model.speed),
            formatThinking(model.thinking),
            formatContextWindow(model.contextWindow),
            formatProbeStatus(model.probeStatus),
        ]);
    }

    out.println(table.toString());
    out.println();

    const ok = models.filter((m) => m.probeStatus === "ok").length;
    const fail = models.filter((m) => m.probeStatus === "fail").length;
    const skipped = models.filter((m) => m.probeStatus === "skipped").length;
    const noProbe = models.filter((m) => m.probeStatus == null).length;

    renderCliSection("Columns");
    renderCliKeyRow("PROXY ID", "account/provider/upstream id (what clients send as model=)");
    renderCliKeyRow("VIS", "picker priority — high=primary, medium=listed, low=legacy/weak");
    renderCliKeyRow("SPEED", "relative latency class (not a hard SLA)");
    renderCliKeyRow("THINK", "reasoning mode: none | optional | reasoning | multi-agent");
    renderCliKeyRow("CTX", "context window in tokens (— if unknown)");
    renderCliKeyRow(
        "PROBE",
        "ok=upstream advertises it (or Grok chat-probe ok) · fail=Grok dead id · skip=static fallback · n/a=no signal"
    );
    out.println();

    const probeParts = [pc.green(`${ok} ok`), fail > 0 ? pc.red(`${fail} fail`) : pc.dim("0 fail")];

    if (skipped > 0) {
        probeParts.push(pc.yellow(`${skipped} skip`));
    }

    if (noProbe > 0) {
        probeParts.push(pc.dim(`${noProbe} n/a`));
    }

    out.println(
        `${pc.dim(`  ${models.length} model${models.length === 1 ? "" : "s"}`)}${pc.dim("  ·  probe ")}${probeParts.join(
            pc.dim(" · ")
        )}`
    );
    out.println();

    out.println(
        `${pc.dim("  Next  ")}${pc.cyan(cmd(["models", "--visibility", "high"]))}${pc.dim("  ·  ")}${pc.cyan(
            cmd(["models", "--provider", "grok"])
        )}${pc.dim("  ·  ")}${pc.cyan(cmd(["models", "--json"]))}`
    );

    if (fail > 0) {
        const failAccount =
            models.find((model) => model.probeStatus === "fail")?.accountName ?? models[0]?.accountName ?? "<name>";

        out.println(
            `${pc.dim("  Debug ")}${pc.cyan(cmd(["accounts", "test", failAccount]))}${pc.dim("  ·  ")}${pc.cyan(
                cmd(["internal", "update-models"])
            )}${pc.dim("  ·  re-probes Grok catalog only")}`
        );
        out.println(
            `${pc.dim("  Tip   ")}${pc.cyan("PROBE=ok")} means you can call it. Grok fail rows are legacy dead ids.`
        );
    } else {
        out.println(
            `${pc.dim("  Debug ")}${pc.cyan(cmd(["accounts", "list"]))}${pc.dim("  ·  ")}${pc.cyan(
                cmd(["accounts", "test", "<name>"])
            )}${pc.dim("  ·  ")}${pc.cyan(cmd(["status"]))}`
        );
        out.println(
            `${pc.dim("  Tip   ")}${pc.cyan("PROBE=ok")} = live catalog (Claude/Codex/xAI) or Grok probe. Prefer those.`
        );
    }

    out.println();
}

export function displayAccountsTable(rows: AccountListRow[]): void {
    renderCliHeader("Proxy Accounts", "configured upstream credentials");

    if (rows.length === 0) {
        out.println(pc.dim("  No accounts configured.\n"));
        out.println(
            `${pc.dim("  Next: ")}${pc.cyan(cmd(["config", "detect"]))}${pc.dim("  ·  ")}${pc.cyan(cmd(["config", "init"]))}`
        );
        out.println();
        return;
    }

    const table = createBoxTable(["NAME", "SLUG", "PROVIDER", "ENABLED", "MODELS", "NOTE"]);

    for (const { account, modelCount } of rows) {
        const note = accountNote(account, modelCount);
        const modelsCell = modelCount > 0 ? pc.white(String(modelCount)) : pc.yellow("0");

        table.push([
            pc.white(pc.bold(account.name)),
            pc.cyan(account.providerSlug),
            pc.dim(truncateDisplay(account.provider, 28)),
            formatEnabled(account.enabled),
            modelsCell,
            note === "—" ? pc.dim("—") : pc.yellow(note),
        ]);
    }

    out.println(table.toString());
    out.println();

    renderCliSection("Columns");
    renderCliKeyRow("NAME", "account key used in proxy ids (first segment)");
    renderCliKeyRow("SLUG", "provider slug (second segment of proxy id)");
    renderCliKeyRow("PROVIDER", "backend type (subscription vs api-key)");
    renderCliKeyRow("ENABLED", "whether this account is used at runtime");
    renderCliKeyRow("MODELS", "count from proxy catalog (0 = not listed / not wired)");
    renderCliKeyRow("NOTE", "why models may be empty or account skipped");
    out.println();

    const enabled = rows.filter((r) => r.account.enabled).length;
    const zeroModels = rows.filter((r) => r.modelCount === 0).length;

    out.println(
        `${pc.dim(`  ${rows.length} account${rows.length === 1 ? "" : "s"}`)}${pc.dim("  ·  ")}${pc.green(
            `${enabled} enabled`
        )}${zeroModels > 0 ? `${pc.dim("  ·  ")}${pc.yellow(`${zeroModels} with 0 models`)}` : ""}`
    );
    out.println();

    const firstName = rows[0]?.account.name ?? "<name>";
    out.println(
        `${pc.dim("  Next  ")}${pc.cyan(cmd(["accounts", "test", firstName]))}${pc.dim("  ·  ")}${pc.cyan(
            cmd(["models"])
        )}${pc.dim("  ·  ")}${pc.cyan(cmd(["usage", "--account", firstName]))}`
    );
    out.println(
        `${pc.dim("  Debug ")}${pc.cyan(cmd(["config", "show"]))}${pc.dim("  ·  ")}${pc.cyan(
            cmd(["config", "detect"])
        )}${pc.dim("  ·  ")}${pc.cyan(cmd(["status"]))}`
    );

    if (zeroModels > 0) {
        out.println(
            `${pc.dim("  Tip   ")}MODELS=0 → check NOTE, then ${pc.cyan("accounts test <name>")}${pc.dim(
                " (missing key, disabled, or upstream catalog empty)"
            )}`
        );
    }

    out.println();
}

export function displayAccountTestResult(input: {
    name: string;
    provider: string;
    providerSlug: string;
    summary: string;
    modelCount: number;
    modelsSample?: string[];
}): void {
    renderCliHeader(`Account: ${input.name}`, "upstream ping");

    renderCliSection("Result");
    renderCliKeyRow("Provider", pc.white(input.provider), 14);
    renderCliKeyRow("Slug", pc.cyan(input.providerSlug), 14);
    renderCliKeyRow("Usage", pc.white(input.summary), 14);
    renderCliKeyRow("Models", input.modelCount > 0 ? pc.green(String(input.modelCount)) : pc.yellow("0"), 14);

    if (input.modelsSample && input.modelsSample.length > 0) {
        renderCliKeyRow("Sample", pc.dim(input.modelsSample.slice(0, 5).join(", ")), 14);
    }

    out.println();
    out.println(
        `${pc.dim("  Next  ")}${pc.cyan(cmd(["models", "--provider", input.providerSlug]))}${pc.dim("  ·  ")}${pc.cyan(
            cmd(["usage", "--account", input.name])
        )}${pc.dim("  ·  ")}${pc.cyan(cmd(["status"]))}`
    );
    out.println();
}
