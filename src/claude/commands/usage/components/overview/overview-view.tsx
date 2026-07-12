import type { PollResult } from "@app/claude/commands/usage/types";
import type { AccountUsage } from "@app/claude/lib/usage/api";
import type { UsageDashboardConfig } from "@app/claude/lib/usage/dashboard-config";
import { useTerminalSize } from "@app/utils/ink/hooks/use-terminal-size";
import { Box, Text } from "ink";
import { AccountSection, estimateAccountHeight } from "./account-section";

// Frame chrome around the account list: TabBar(1) + StatusBar(2) +
// paddingY(2) + height clamp margin(1).
const CHROME_LINES = 6;
// A column needs room for the fixed row layout plus a readable bar.
const MIN_COLUMN_WIDTH = 60;
const COLUMN_GAP = 2;

interface OverviewViewProps {
    results: PollResult | null;
    config: UsageDashboardConfig;
}

/** Split accounts into two columns balanced by rendered height, order kept. */
function splitByHeight(accounts: AccountUsage[], prominentBuckets: string[]): [AccountUsage[], AccountUsage[]] {
    const heights = accounts.map((a) => estimateAccountHeight(a, prominentBuckets));
    const total = heights.reduce((sum, h) => sum + h, 0);
    let left = 0;
    let splitAt = accounts.length;

    for (let i = 0; i < accounts.length; i++) {
        if (left + heights[i] / 2 > total / 2) {
            splitAt = i;
            break;
        }

        left += heights[i];
    }

    return [accounts.slice(0, Math.max(1, splitAt)), accounts.slice(Math.max(1, splitAt))];
}

export function OverviewView({ results, config }: OverviewViewProps) {
    const { columns: termWidth, rows: termHeight } = useTerminalSize();

    if (!results) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"Loading usage data..."}</Text>
            </Box>
        );
    }

    // Full-screen error only when there is nothing at all to show — with
    // last-good data on hand, degrade to a banner above the account sections.
    if (results.error && results.accounts.length === 0) {
        return (
            <Box paddingX={1} flexDirection="column">
                <Text color="red" bold>
                    {"Error"}
                </Text>
                <Text color="red">{results.error}</Text>
            </Box>
        );
    }

    if (results.accounts.length === 0) {
        return (
            <Box paddingX={1}>
                <Text dimColor>{"No accounts configured. Run: tools claude config"}</Text>
            </Box>
        );
    }

    const totalHeight = results.accounts.reduce((sum, a) => sum + estimateAccountHeight(a, config.prominentBuckets), 0);
    const availableRows = termHeight - CHROME_LINES - (results.error ? 1 : 0);
    const columnWidth = Math.floor((termWidth - 2 - COLUMN_GAP) / 2);
    const useTwoColumns = results.accounts.length > 1 && totalHeight > availableRows && columnWidth >= MIN_COLUMN_WIDTH;

    if (!useTwoColumns) {
        return (
            <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
                {results.error ? <Text color="yellow">{`  ⚠ Last poll failed: ${results.error}`}</Text> : null}
                {results.accounts.map((account) => (
                    <AccountSection
                        key={account.accountName}
                        account={account}
                        prominentBuckets={config.prominentBuckets}
                    />
                ))}
            </Box>
        );
    }

    const [leftAccounts, rightAccounts] = splitByHeight(results.accounts, config.prominentBuckets);

    return (
        <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
            {results.error ? <Text color="yellow">{`  ⚠ Last poll failed: ${results.error}`}</Text> : null}
            <Box flexDirection="row">
                <Box flexDirection="column" width={columnWidth} marginRight={COLUMN_GAP}>
                    {leftAccounts.map((account) => (
                        <AccountSection
                            key={account.accountName}
                            account={account}
                            prominentBuckets={config.prominentBuckets}
                            width={columnWidth}
                        />
                    ))}
                </Box>
                <Box flexDirection="column" width={columnWidth}>
                    {rightAccounts.map((account) => (
                        <AccountSection
                            key={account.accountName}
                            account={account}
                            prominentBuckets={config.prominentBuckets}
                            width={columnWidth}
                        />
                    ))}
                </Box>
            </Box>
        </Box>
    );
}
