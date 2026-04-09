import { Card, CardContent } from "@ui/components/card";

interface ExportSummaryProps {
    totalHours: number;
    totalEntries: number;
    workItemCount: number;
    dayCount: number;
}

export function ExportSummary({ totalHours, totalEntries, workItemCount, dayCount }: ExportSummaryProps) {
    const stats = [
        { label: "Total Hours", value: totalHours.toFixed(1), accent: true },
        { label: "Entries", value: String(totalEntries), accent: false },
        { label: "Work Items", value: String(workItemCount), accent: false },
        { label: "Days", value: String(dayCount), accent: false },
    ];

    return (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {stats.map((stat) => (
                <Card key={stat.label} className="border-white/5">
                    <CardContent className="p-4 text-center">
                        <div
                            className={`font-mono text-2xl font-bold ${stat.accent ? "text-primary" : "text-muted-foreground"}`}
                        >
                            {stat.value}
                        </div>
                        <div className="font-mono text-xs text-gray-500 mt-1">{stat.label}</div>
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}
