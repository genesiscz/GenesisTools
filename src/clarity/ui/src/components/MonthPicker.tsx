import { Button } from "@ui/components/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface MonthPickerProps {
    month: number;
    year: number;
    onChange: (month: number, year: number) => void;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function MonthPicker({ month, year, onChange }: MonthPickerProps) {
    const prev = () => {
        if (month === 1) {
            onChange(12, year - 1);
        } else {
            onChange(month - 1, year);
        }
    };

    const next = () => {
        if (month === 12) {
            onChange(1, year + 1);
        } else {
            onChange(month + 1, year);
        }
    };

    return (
        <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={prev} className="text-gray-400 hover:text-gray-200">
                <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="font-mono text-sm text-gray-300 min-w-[100px] text-center">
                {MONTH_NAMES[month - 1]} {year}
            </span>
            <Button variant="ghost" size="sm" onClick={next} className="text-gray-400 hover:text-gray-200">
                <ChevronRight className="w-4 h-4" />
            </Button>
        </div>
    );
}
