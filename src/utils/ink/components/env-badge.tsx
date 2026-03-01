/**
 * EnvBadge — Colored environment badge.
 *
 * Renders environment names with color coding:
 *   [DEV] in blue, [STAGING] in yellow, [PROD] in red bold.
 *
 * Usage:
 *   <EnvBadge env="prod" />
 */

import { Text } from "ink";
import { type EnvironmentName, getEnvColor } from "../lib/theme.js";

interface EnvBadgeProps {
    env: EnvironmentName;
}

const LABELS: Record<EnvironmentName, string> = {
    dev: "DEV",
    staging: "STAGING",
    prod: "PROD",
};

export function EnvBadge({ env }: EnvBadgeProps) {
    const color = getEnvColor(env);
    const isProd = env === "prod";

    return (
        <Text color={color} bold={isProd}>
            [{LABELS[env]}]
        </Text>
    );
}
