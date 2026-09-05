import { SessionsView } from "@app/claude/commands/usage/components/sessions/sessions-view";
import { anthropicPresenters } from "@app/claude/commands/usage/presenter";
import { renderFullScreen } from "@genesiscz/utils/ink";
import { UsageDashboard } from "@genesiscz/utils/ink/usage-dashboard/app";
import { buildUsageDataSource } from "@genesiscz/utils/ink/usage-dashboard/source";

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
