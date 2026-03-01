/**
 * HealthTable — Health check results display.
 *
 * Shows each URL with a status icon, HTTP status code, and response time.
 *
 * Usage:
 *   <HealthTable results={[
 *     { url: 'https://api.fixit.app/health', status: 200, ok: true, responseTime: 142 },
 *     { url: 'https://fixit.app', status: 503, ok: false, responseTime: 2100 },
 *   ]} />
 */

import { Box, Text } from "ink";
import { symbols, theme } from "../lib/theme.js";
import type { HealthCheckResult } from "../lib/types.js";

interface HealthTableProps {
    results: HealthCheckResult[];
}

export function HealthTable({ results }: HealthTableProps) {
    if (results.length === 0) {
        return <Text color={theme.muted}>No health check results.</Text>;
    }

    return (
        <Box flexDirection="column">
            {results.map((result, i) => {
                const icon = result.ok ? symbols.success : symbols.error;
                const iconColor = result.ok ? theme.success : theme.error;
                const statusColor = result.ok ? theme.success : theme.error;
                const timeColor =
                    result.responseTime < 300
                        ? theme.success
                        : result.responseTime < 1000
                          ? theme.warning
                          : theme.error;

                return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static list rendering
                    <Box key={i} gap={1}>
                        <Text color={iconColor}>{icon}</Text>
                        <Text color={statusColor} bold>
                            {result.status}
                        </Text>
                        <Text>{result.url}</Text>
                        <Text color={timeColor}>({result.responseTime}ms)</Text>
                    </Box>
                );
            })}
        </Box>
    );
}
