import { cn } from "@ui/lib/utils";
import { Star } from "lucide-react";

const sizes = {
    sm: "size-3.5",
    md: "size-4",
    lg: "size-5",
};

interface StarRatingProps {
    rating: number;
    maxStars?: number;
    size?: keyof typeof sizes;
    showValue?: boolean;
    className?: string;
}

export function StarRating({ rating, maxStars = 5, size = "md", showValue = false, className }: StarRatingProps) {
    return (
        <div className={cn("flex items-center gap-1", className)}>
            {Array.from({ length: maxStars }).map((_, i) => (
                <Star
                    key={i}
                    className={cn(
                        sizes[size],
                        i < Math.floor(rating) ? "fill-amber-400 text-amber-400" : "fill-zinc-700 text-zinc-700"
                    )}
                />
            ))}
            {showValue && <span className="ml-2 text-sm font-medium text-zinc-300">{rating.toFixed(1)}</span>}
        </div>
    );
}
