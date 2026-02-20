/**
 * Azure DevOps CLI - Work item change detection
 */

import type {
    CacheEntry,
    ChangeInfo,
    WorkItem,
} from "@app/azure-devops/types";

export function detectChanges(oldItems: CacheEntry[], newItems: WorkItem[]): ChangeInfo[] {
    const changes: ChangeInfo[] = [];
    const oldMap = new Map(oldItems.map((item) => [item.id, item]));

    for (const newItem of newItems) {
        const oldItem = oldMap.get(newItem.id);
        const newEntry: CacheEntry = {
            id: newItem.id,
            changed: newItem.changed,
            rev: newItem.rev,
            title: newItem.title,
            state: newItem.state,
            severity: newItem.severity,
            assignee: newItem.assignee,
            url: newItem.url,
        };

        if (!oldItem) {
            changes.push({ type: "new", id: newItem.id, changes: ["New work item"], newData: newEntry });
        } else if (newItem.changed > oldItem.changed || newItem.rev > oldItem.rev) {
            const changeList: string[] = [];

            if (oldItem.state !== newItem.state) {
                changeList.push(`State: ${oldItem.state} → ${newItem.state}`);
            }

            if (oldItem.assignee !== newItem.assignee) {
                changeList.push(`Assignee: ${oldItem.assignee || "unassigned"} → ${newItem.assignee || "unassigned"}`);
            }

            if (oldItem.severity !== newItem.severity) {
                changeList.push(`Severity: ${oldItem.severity} → ${newItem.severity}`);
            }

            if (oldItem.title !== newItem.title) {
                changeList.push(`Title changed`);
            }

            if (changeList.length === 0) {
                changeList.push("Updated (comments or other fields)");
            }

            changes.push({ type: "updated", id: newItem.id, changes: changeList, oldData: oldItem, newData: newEntry });
        }
    }

    return changes;
}
