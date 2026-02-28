import { Box, Text } from "ink";
import type { PollResult } from "../../types";
import type { UsageDashboardConfig } from "@app/claude/lib/usage/dashboard-config";
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

    if (results.error) {
        return (
            <Box paddingX={1} flexDirection="column">
                <Text color="red" bold>{"Error"}</Text>
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
        <Box flexDirection="column" paddingX={1} paddingY={1}>
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
