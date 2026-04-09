import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { MapPinned } from "lucide-react";
import { buildDistrictContextItems } from "./district-comparison-model";

export function DistrictContextCallout({ districts }: { districts: string[] }) {
    const items = buildDistrictContextItems(districts);

    return (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
                <Card key={item.district} className="border-white/5 bg-white/[0.02]">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-sm font-mono text-amber-300">
                            <MapPinned className="w-4 h-4" />
                            {item.title}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                        <Section label="Highlights" values={item.highlights} tone="amber" />
                        <Section label="Transport" values={item.transport} tone="cyan" />
                        <Section label="Developments" values={item.developments} tone="emerald" />
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}

function Section({ label, values, tone }: { label: string; values: string[]; tone: "amber" | "cyan" | "emerald" }) {
    const toneClass =
        tone === "amber"
            ? "border-amber-500/20 bg-amber-500/5 text-amber-200"
            : tone === "cyan"
              ? "border-cyan-500/20 bg-cyan-500/5 text-cyan-200"
              : "border-emerald-500/20 bg-emerald-500/5 text-emerald-200";

    return (
        <div className="flex flex-col gap-2">
            <div className="text-[10px] font-mono uppercase tracking-[0.24em] text-gray-500">{label}</div>
            <div className="flex flex-wrap gap-2">
                {values.map((value) => (
                    <Badge key={value} variant="outline" className={toneClass}>
                        {value}
                    </Badge>
                ))}
            </div>
        </div>
    );
}
