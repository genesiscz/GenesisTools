import { anthropicPresenters } from "@app/claude/commands/usage/presenter";
import type { UsagePresenters } from "@genesiscz/utils/ai/providers/account-features";
import { renderFullScreen } from "@genesiscz/utils/ink";
import { UsageDashboard } from "@genesiscz/utils/ink/usage-dashboard/app";
import { buildUsageDataSource } from "@genesiscz/utils/ink/usage-dashboard/source";

export interface RenderAiUsageTuiOptions {
    providers?: string[];
    accountFilter?: string[];
    /** Initial History range in minutes. */
    range?: number;
}

/**
 * Presenters live with the command, not on the plugin: they are React components, and a
 * plugin holding one would drag Ink into every `tools ai config` call. Codex and grok have
 * none, so the shell draws their windows as generic bars.
 */
const PRESENTERS: Record<string, UsagePresenters | undefined> = {
    "anthropic-sub": anthropicPresenters,
};

export async function renderAiUsageTui(opts: RenderAiUsageTuiOptions = {}): Promise<void> {
    const source = await buildUsageDataSource({
        ...(opts.providers === undefined ? {} : { providers: opts.providers }),
        presenters: PRESENTERS,
    });

    await renderFullScreen(
        <UsageDashboard
            source={source}
            {...(opts.accountFilter === undefined ? {} : { accountFilter: opts.accountFilter })}
            {...(opts.range === undefined ? {} : { range: opts.range })}
        />
    );
}
