import { Card } from "@ui/components/card";
import { cn } from "@ui/lib/utils";
import { Quote, Shield, Star } from "lucide-react";

interface TestimonialCardProps {
    quote: string;
    author: {
        name: string;
        role: string;
    };
    rating?: number;
    featured?: boolean;
    verified?: boolean;
    className?: string;
}

export function TestimonialCard({
    quote,
    author,
    rating = 5,
    featured = false,
    verified = false,
    className,
}: TestimonialCardProps) {
    if (featured) {
        return (
            <Card className={cn("rounded-[20px] p-6 gap-4", className)}>
                <Quote size={24} className="text-primary/30" />
                <p className="text-sm text-foreground leading-relaxed">{quote}</p>
                <div className="flex items-center gap-1">
                    {Array.from({ length: rating }).map((_, i) => (
                        <Star key={i} size={14} className="text-amber-400 fill-amber-400" />
                    ))}
                </div>
                <div className="flex items-center gap-3">
                    <div className="size-10 rounded-full bg-gradient-to-br from-primary to-violet-400 flex items-center justify-center text-white font-semibold text-sm">
                        {author.name.charAt(0)}
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground">{author.name}</span>
                            {verified && <Shield size={14} className="text-emerald-500" />}
                        </div>
                        <span className="text-xs text-muted-foreground">{author.role}</span>
                    </div>
                </div>
            </Card>
        );
    }

    return (
        <Card className={cn("rounded-[20px] p-6 gap-3", className)}>
            <p className="text-xs text-muted-foreground leading-relaxed">{quote}</p>
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="size-7 rounded-full bg-muted flex items-center justify-center text-muted-foreground text-xs font-medium">
                        {author.name.charAt(0)}
                    </div>
                    <div>
                        <span className="text-xs font-medium text-foreground">{author.name}</span>
                        <span className="text-xs text-muted-foreground ml-1.5">{author.role}</span>
                    </div>
                </div>
                <div className="flex items-center gap-0.5">
                    {Array.from({ length: rating }).map((_, i) => (
                        <Star key={i} size={10} className="text-amber-400 fill-amber-400" />
                    ))}
                </div>
            </div>
        </Card>
    );
}
