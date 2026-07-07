import { buildWorkItemUrl } from "@app/azure-devops/lib/urls";
import type { WorkItemTypeColor } from "@app/azure-devops/lib/work-item-enrichment";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui/components/tooltip";
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
                    className="inline-flex items-center gap-1 font-mono text-sm text-primary hover:text-primary/80 hover:underline transition-colors"
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
            <span className="font-mono text-sm text-primary">#{id}</span>
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
        return <span className="text-xs font-mono text-gray-500 whitespace-nowrap">{typeName}</span>;
    }

    return (
        <span
            className="text-xs font-mono px-1.5 py-0.5 rounded whitespace-nowrap"
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

export interface ChainNode {
    id: number;
    title?: string;
    type?: string;
}

interface ChainLinkProps {
    node: ChainNode;
    adoConfig?: AdoConfig | null;
}

/** Work item #id link with the full title in a hover tooltip. */
function ChainLink({ node, adoConfig }: ChainLinkProps) {
    const url = buildWorkItemUrl(node.id, adoConfig);
    const link = url ? (
        <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 font-mono text-primary hover:text-primary/80 hover:underline transition-colors"
        >
            #{node.id}
            <ExternalLink className="w-3 h-3" />
        </a>
    ) : (
        <span className="font-mono text-primary">#{node.id}</span>
    );

    if (!node.title) {
        return link;
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            <TooltipContent className="max-w-md font-mono">{node.title}</TooltipContent>
        </Tooltip>
    );
}

interface WorkItemChainProps {
    /** Hierarchy chain, parent first (e.g. [parent, item]) */
    nodes: ChainNode[];
    adoConfig?: AdoConfig | null;
    typeColors?: Record<string, WorkItemTypeColor>;
}

/** Renders `#parent [US] → #item [Task]` with tooltips carrying the full titles. */
export function WorkItemChain({ nodes, adoConfig, typeColors }: WorkItemChainProps) {
    return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
            {nodes.map((node, i) => (
                <span key={node.id} className="inline-flex items-center gap-1.5">
                    {i > 0 && <span className="text-gray-600">→</span>}
                    <ChainLink node={node} adoConfig={adoConfig} />
                    {node.type && <TypeBadge typeName={node.type} color={typeColors?.[node.type]} />}
                </span>
            ))}
        </span>
    );
}
