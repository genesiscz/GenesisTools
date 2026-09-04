import { providerMeta } from "@/lib/provider-meta";

interface ProviderBadgeProps {
    provider: string;
    /** Show the alias (`codex`) instead of the display name (`Codex`). */
    compact?: boolean;
    title?: string;
}

export function ProviderBadge({ provider, compact, title }: ProviderBadgeProps) {
    const meta = providerMeta(provider);

    return (
        <span
            className="dd-ai-badge"
            title={title ?? `${meta.displayName} (${meta.id})`}
            style={{
                color: meta.color,
                borderColor: `color-mix(in srgb, ${meta.color} 45%, transparent)`,
                background: `color-mix(in srgb, ${meta.color} 10%, transparent)`,
            }}
        >
            {compact ? meta.alias : meta.displayName}
        </span>
    );
}
