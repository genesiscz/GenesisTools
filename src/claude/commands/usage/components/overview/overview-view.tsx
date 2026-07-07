import type { PollResult } from "@app/claude/commands/usage/types";
import type { UsageDashboardConfig } from "@app/claude/lib/usage/dashboard-config";
import { Box, Text } from "ink";
import { AccountSection } from "./account-section";

interface OverviewViewProps {
    results: PollResult | null;
    config: UsageDashboardConfig;
}

export function OverviewView({ results, config }: OverviewViewProps) {
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
