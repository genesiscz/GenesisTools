/**
 * TargetInfo — DB connection display with masked credentials
 */

import { Box, Text } from "ink";
import { colors, symbols } from "../lib/theme.js";

export interface TargetInfoProps {
    databaseUrl?: string;
    envName?: string;
    isProduction?: boolean;
}

function parseDatabaseUrl(url: string): { host: string; port: string; database: string } {
    try {
        const parsed = new URL(url);
        return {
            host: parsed.hostname || "localhost",
            port: parsed.port || "5432",
            database: parsed.pathname.replace(/^\//, "") || "unknown",
        };
    } catch {
        return { host: "unknown", port: "5432", database: "unknown" };
    }
}

/** Mask a DATABASE_URL to hide credentials: postgres://user:pass@host:port/db -> postgres://***@host:port/db */
function maskDatabaseUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//***@${parsed.host}${parsed.pathname}`;
    } catch {
        return "***";
    }
}

export function TargetInfo({ databaseUrl, envName = "local", isProduction }: TargetInfoProps) {
    const db = databaseUrl ? parseDatabaseUrl(databaseUrl) : null;

    return (
        <Box flexDirection="column" marginTop={1}>
            <Text>
                {symbols.target} <Text dimColor>Target: </Text>
                <Text bold color={isProduction ? colors.error : colors.info}>
                    {envName}
                </Text>
                {db && (
                    <Text dimColor>
                        {" "}
                        ({db.host}:{db.port}/{db.database})
                    </Text>
                )}
            </Text>
            {isProduction && (
                <Text color={colors.error}>
                    {"  "}
                    {symbols.warning} Production environment detected!
                </Text>
            )}
        </Box>
    );
}

// Export for use in error messages that need a safe URL representation
export { maskDatabaseUrl };
