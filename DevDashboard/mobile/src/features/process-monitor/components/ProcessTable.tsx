import { Fragment } from "react";
import { View } from "react-native";
import { ProcessRow } from "@/features/process-monitor/components/ProcessRow";
import { SortToggle } from "@/features/process-monitor/components/SortToggle";
import type { ProcessInfo, ProcessSort } from "@/features/process-monitor/types";
import { Card } from "@/ui/Card";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

interface ProcessTableProps {
    processes: ProcessInfo[];
    sort: ProcessSort;
    onSortChange: (sort: ProcessSort) => void;
    onKill: (pid: number) => void;
}

/**
 * The process table surface: a header row (count + SortToggle) above the list of `ProcessRow`s,
 * inside a single `<Card>` (never override its surface). Hairline separators between rows match the
 * web table look. Empty/loading are owned by the screen; this only renders when there are rows.
 * testID `process-monitor-table`.
 */
export function ProcessTable({ processes, sort, onSortChange, onKill }: ProcessTableProps) {
    const c = useThemeColors();

    return (
        <Card testID="process-monitor-table" className="gap-3">
            <View className="flex-row items-center justify-between">
                <SectionHeader title={`Processes (${processes.length})`} />
                <SortToggle sort={sort} onChange={onSortChange} />
            </View>

            <View>
                {processes.map((process, index) => (
                    <Fragment key={process.pid}>
                        {index > 0 ? <View className="h-px" style={{ backgroundColor: c.border }} /> : null}
                        <ProcessRow process={process} onKill={onKill} />
                    </Fragment>
                ))}
            </View>
        </Card>
    );
}
