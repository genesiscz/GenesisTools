import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { DistrictCommandSelect } from "@ui/components/command";
import { MapPinned } from "lucide-react";
import { DEFAULT_COMPARE_DISTRICTS } from "./compare-query";

export function DistrictPicker({
    selectedDistricts,
    setSelectedDistricts,
    maxDistricts,
}: {
    selectedDistricts: string[];
    setSelectedDistricts: (districts: string[]) => void;
    maxDistricts: number;
}) {
    const districtCountLabel = `${selectedDistricts.length}/${maxDistricts}`;

    return (
        <Card className="border-white/5 bg-white/[0.02] overflow-visible">
            <CardHeader className="gap-3">
                <div className="flex items-center justify-between gap-3">
                    <CardTitle className="text-xs font-mono text-gray-300 flex items-center gap-2">
                        <MapPinned className="w-4 h-4 text-amber-300" />
                        District basket
                    </CardTitle>
                    <Badge
                        variant="outline"
                        className="border-amber-500/20 bg-amber-500/5 text-[10px] font-mono text-amber-200"
                    >
                        {districtCountLabel}
                    </Badge>
                </div>
                <p className="text-xs font-mono text-gray-500">
                    Build a comparison set for Prague wards or mix in broader districts. The default basket starts with
                    Praha 1-10.
                </p>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 overflow-visible">
                <DistrictCommandSelect
                    mode="multi"
                    selected={selectedDistricts}
                    onValueChange={setSelectedDistricts}
                    maxSelections={maxDistricts}
                    placeholder="Select districts..."
                    searchPlaceholder="Search districts..."
                    shouldFilter={false}
                />
                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setSelectedDistricts([...DEFAULT_COMPARE_DISTRICTS])}
                        className="border-cyan-500/20 bg-cyan-500/5 font-mono text-xs text-cyan-200 hover:bg-cyan-500/10"
                    >
                        Reset to Praha 1-10
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setSelectedDistricts([])}
                        className="border-white/10 bg-black/20 font-mono text-xs text-gray-300 hover:bg-white/[0.04]"
                    >
                        Clear basket
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
