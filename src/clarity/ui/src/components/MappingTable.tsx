import type { WorkItemTypeColor } from "@app/azure-devops/lib/work-item-enrichment";
import type { ClarityMapping } from "@app/clarity/config";
import type { ClarityTask } from "@app/clarity/lib/types";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { GripVertical, Plus, Unlink } from "lucide-react";
import { useState } from "react";
import type { AdoConfig } from "./WorkItemLink";
import { TypeBadge, WorkItemLink } from "./WorkItemLink";

export interface ClarityGroup {
    clarityTaskId: number;
    clarityTaskName: string;
    clarityTaskCode: string;
    clarityInvestmentName: string;
    clarityInvestmentCode: string;
    items: ClarityMapping[];
}

interface MappingTableProps {
    mappings: ClarityMapping[];
    allTasks?: ClarityTask[];
    typeColors: Record<string, WorkItemTypeColor>;
    adoConfig?: AdoConfig | null;
    onRemove: (adoWorkItemId: number) => void;
    onMove: (adoWorkItemId: number, target: ClarityGroup) => void;
    onAdd?: (task: ClarityGroup) => void;
}

function groupMappings(mappings: ClarityMapping[], allTasks?: ClarityTask[]): ClarityGroup[] {
    const groups = new Map<number, ClarityGroup>();

    for (const m of mappings) {
        let group = groups.get(m.clarityTaskId);

        if (!group) {
            group = {
                clarityTaskId: m.clarityTaskId,
                clarityTaskName: m.clarityTaskName,
                clarityTaskCode: m.clarityTaskCode,
                clarityInvestmentName: m.clarityInvestmentName,
                clarityInvestmentCode: m.clarityInvestmentCode,
                items: [],
            };
            groups.set(m.clarityTaskId, group);
        }

        group.items.push(m);
    }

    if (allTasks) {
        for (const task of allTasks) {
            if (!groups.has(task.taskId)) {
                groups.set(task.taskId, {
                    clarityTaskId: task.taskId,
                    clarityTaskName: task.taskName,
                    clarityTaskCode: task.taskCode,
                    clarityInvestmentName: task.investmentName,
                    clarityInvestmentCode: task.investmentCode,
                    items: [],
                });
            }
        }
    }

    return [...groups.values()].sort((a, b) => a.clarityTaskName.localeCompare(b.clarityTaskName));
}

export function MappingTable({
    mappings,
    allTasks,
    typeColors,
    adoConfig,
    onRemove,
    onMove,
    onAdd,
}: MappingTableProps) {
    const [dragOverGroupId, setDragOverGroupId] = useState<number | null>(null);
    const [draggedItemId, setDraggedItemId] = useState<number | null>(null);

    const groups = groupMappings(mappings, allTasks);

    if (groups.length === 0) {
        return (
            <div className="text-center py-12 text-gray-500 font-mono text-sm">
                No mappings configured. Use the form below or{" "}
                <code className="text-amber-400">tools clarity link-workitems</code> to create mappings.
            </div>
        );
    }

    function handleDragStart(e: React.DragEvent, adoWorkItemId: number) {
        e.dataTransfer.setData("text/plain", String(adoWorkItemId));
        e.dataTransfer.effectAllowed = "move";
        setDraggedItemId(adoWorkItemId);
    }

    function handleDragEnd() {
        setDraggedItemId(null);
        setDragOverGroupId(null);
    }

    function handleDragOver(e: React.DragEvent, groupId: number) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOverGroupId(groupId);
    }

    function handleDragLeave(e: React.DragEvent, groupId: number) {
        const relatedTarget = e.relatedTarget as HTMLElement | null;
        const currentTarget = e.currentTarget as HTMLElement;

        if (!relatedTarget || !currentTarget.contains(relatedTarget)) {
            if (dragOverGroupId === groupId) {
                setDragOverGroupId(null);
            }
        }
    }

    function handleDrop(e: React.DragEvent, targetGroup: ClarityGroup) {
        e.preventDefault();
        setDragOverGroupId(null);
        setDraggedItemId(null);

        const workItemId = Number(e.dataTransfer.getData("text/plain"));

        if (!workItemId) {
            return;
        }

        const sourceMapping = mappings.find((m) => m.adoWorkItemId === workItemId);

        if (!sourceMapping || sourceMapping.clarityTaskId === targetGroup.clarityTaskId) {
            return;
        }

        onMove(workItemId, targetGroup);
    }

    return (
        <div className="space-y-4">
            {groups.map((group) => {
                const isDropTarget = dragOverGroupId === group.clarityTaskId && draggedItemId !== null;
                const containsDraggedItem =
                    draggedItemId !== null && group.items.some((i) => i.adoWorkItemId === draggedItemId);

                return (
                    <div
                        key={group.clarityTaskId}
                        role="listbox"
                        className={`rounded-lg border transition-colors ${
                            isDropTarget && !containsDraggedItem
                                ? "border-amber-500/60 bg-amber-500/5"
                                : "border-white/10 bg-white/[0.02]"
                        }`}
                        onDragOver={(e) => handleDragOver(e, group.clarityTaskId)}
                        onDragLeave={(e) => handleDragLeave(e, group.clarityTaskId)}
                        onDrop={(e) => handleDrop(e, group)}
                    >
                        {/* Group Header */}
                        <div className="px-4 py-3 border-b border-white/5">
                            <div className="flex items-center justify-between">
                                <div>
                                    <div className="font-mono text-sm text-gray-200">{group.clarityTaskName}</div>
                                    <div className="font-mono text-xs text-gray-500">
                                        {group.clarityTaskCode}
                                        {group.clarityInvestmentName && ` · ${group.clarityInvestmentName}`}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Badge variant="outline" className="font-mono text-xs text-gray-500">
                                        {group.items.length} {group.items.length === 1 ? "item" : "items"}
                                    </Badge>
                                    {onAdd && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => onAdd(group)}
                                            className="text-amber-400/60 hover:text-amber-300 hover:bg-amber-500/10 h-7 w-7 p-0"
                                        >
                                            <Plus className="w-3.5 h-3.5" />
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Work Item Rows */}
                        <div className="divide-y divide-white/5">
                            {group.items.length === 0 ? (
                                <div className="px-4 py-3 text-center text-gray-600 font-mono text-xs">
                                    No work items mapped — drag items here or click +
                                </div>
                            ) : (
                                group.items.map((item) => {
                                    const typeColor = item.adoWorkItemType
                                        ? typeColors[item.adoWorkItemType]
                                        : undefined;

                                    return (
                                        <div
                                            key={item.adoWorkItemId}
                                            role="option"
                                            tabIndex={0}
                                            draggable
                                            onDragStart={(e) => handleDragStart(e, item.adoWorkItemId)}
                                            onDragEnd={handleDragEnd}
                                            className={`flex items-center gap-3 px-4 py-2.5 hover:bg-amber-500/5 cursor-grab active:cursor-grabbing transition-opacity ${
                                                draggedItemId === item.adoWorkItemId ? "opacity-40" : ""
                                            }`}
                                            style={
                                                typeColor
                                                    ? { borderLeft: `3px solid #${typeColor.color}` }
                                                    : { borderLeft: "3px solid transparent" }
                                            }
                                        >
                                            <GripVertical className="w-3.5 h-3.5 text-gray-600 flex-shrink-0" />

                                            <div className="flex-1 min-w-0">
                                                <WorkItemLink
                                                    id={item.adoWorkItemId}
                                                    title={item.adoWorkItemTitle}
                                                    adoConfig={adoConfig}
                                                />
                                            </div>

                                            {item.adoWorkItemType && (
                                                <TypeBadge typeName={item.adoWorkItemType} color={typeColor} />
                                            )}

                                            <Button
                                                type="button"
                                                aria-label={`Remove mapping for ADO work item ${item.adoWorkItemId}`}
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => onRemove(item.adoWorkItemId)}
                                                className="text-red-400 hover:text-red-300 hover:bg-red-500/10 flex-shrink-0"
                                            >
                                                <Unlink className="w-3.5 h-3.5" />
                                            </Button>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
