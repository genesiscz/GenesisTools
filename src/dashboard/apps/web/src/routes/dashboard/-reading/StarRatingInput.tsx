import { cn } from "@ui/lib/utils";
import { Star } from "lucide-react";
import { useState } from "react";

interface StarRatingInputProps {
    rating: number;
    onRate: (rating: number) => void;
    size?: "sm" | "md" | "lg";
    className?: string;
    "data-testid"?: string;
}

const sizes = {
    sm: "size-4",
    md: "size-5",
    lg: "size-6",
};

export function StarRatingInput({
    rating,
    onRate,
    size = "md",
    className,
    "data-testid": testId,
}: StarRatingInputProps) {
    const [hover, setHover] = useState(0);
    const active = hover || rating;

    return (
        <div className={cn("flex items-center gap-1", className)} data-testid={testId}>
            {Array.from({ length: 5 }).map((_, i) => {
                const value = i + 1;
                return (
                    <button
                        key={value}
                        type="button"
                        aria-label={`Rate ${value} star${value === 1 ? "" : "s"}`}
                        onMouseEnter={() => setHover(value)}
                        onMouseLeave={() => setHover(0)}
                        onClick={() => onRate(rating === value ? 0 : value)}
                        className="transition-transform hover:scale-110"
                    >
                        <Star
                            className={cn(
                                sizes[size],
                                "transition-colors",
                                value <= active
                                    ? "fill-amber-400 text-amber-400"
                                    : "fill-muted/30 text-muted-foreground/40"
                            )}
                        />
                    </button>
                );
            })}
        </div>
    );
}
