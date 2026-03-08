import { buildWorkItemUrl } from "@app/azure-devops/lib/urls";
import type { WorkItemTypeColor } from "@app/azure-devops/lib/work-item-enrichment";
import { ExternalLink } from "lucide-react";

export { buildWorkItemUrl };

export interface AdoConfig {
    org: string;
    project: string;
}

interface WorkItemLinkProps {
    id: number;
    title?: string;
    adoConfig?: AdoConfig | null;
}

export function WorkItemLink({ id, title, adoConfig }: WorkItemLinkProps) {
    const url = buildWorkItemUrl(id, adoConfig);

    if (url) {
        return (
            <div className="flex items-center gap-2">
                <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-sm text-amber-400 hover:text-amber-300 hover:underline"
                >
                    #{id}
                    <ExternalLink className="w-3 h-3" />
                </a>
                {title && <span className="text-sm text-gray-400">{title}</span>}
            </div>
        );
    }

    return (
        <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-amber-400">#{id}</span>
            {title && <span className="text-sm text-gray-400">{title}</span>}
        </div>
    );
}

interface TypeBadgeProps {
    typeName: string;
    color?: WorkItemTypeColor;
}

export function TypeBadge({ typeName, color }: TypeBadgeProps) {
    if (!color) {
        return <span className="text-xs font-mono text-gray-500">{typeName}</span>;
    }

    return (
        <span
            className="text-xs font-mono px-1.5 py-0.5 rounded"
            style={{
                borderLeft: `3px solid #${color.color}`,
                backgroundColor: `#${color.color}18`,
                color: `#${color.color}`,
            }}
        >
            {typeName}
        </span>
    );
}
