import { SessionsView } from "@app/claude/commands/usage/components/sessions/sessions-view";
import { anthropicPresenters } from "@app/claude/commands/usage/presenter";
import { refreshAccountLabels } from "@app/claude/lib/config";
import { renderFullScreen } from "@genesiscz/utils/ink";
import { UsageDashboard } from "@genesiscz/utils/ink/usage-dashboard/app";
import { buildUsageDataSource } from "@genesiscz/utils/ink/usage-dashboard/source";
import { logger } from "@genesiscz/utils/logger";

export interface RenderUsageTuiOptions {
    accountFilter?: string[];
    /** Initial History range in minutes. */
    range?: number;
}

/**
 * `tools claude usage` is the shared dashboard pinned to one provider: the anthropic
 * presenter for the Overview blocks, plus the Sessions tab, which is claude-only because
 * it reads Claude Code's own transcript files rather than anything a provider reports.
 */
export async function renderUsageTui(opts: RenderUsageTuiOptions = {}): Promise<void> {
    // Best-effort and deliberately not awaited, exactly as the old poller ran it on mount:
    // account labels come from the OAuth profile, and without this an account renamed at
    // Anthropic keeps its stale label in the Overview until something else refreshes it.
    void refreshAccountLabels().catch((err) => logger.debug({ err }, "[claude-usage] refreshAccountLabels failed"));

    const source = await buildUsageDataSource({
        providers: ["anthropic-sub"],
        presenters: { "anthropic-sub": anthropicPresenters },
        extraTabs: [{ id: "sessions", label: "Sessions", shortcut: "3", View: SessionsView }],
    });

    await renderFullScreen(
        <UsageDashboard
            source={source}
            {...(opts.accountFilter === undefined ? {} : { accountFilter: opts.accountFilter })}
            {...(opts.range === undefined ? {} : { range: opts.range })}
            helpLines={anthropicPresenters.helpLines}
        />
    );
}
