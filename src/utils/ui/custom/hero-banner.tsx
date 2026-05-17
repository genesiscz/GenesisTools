import { cn } from "@ui/lib/utils";
import type React from "react";
import { GlowOrbsNexus } from "./glow-orbs";

interface HeroBannerProps {
    eyebrow: string;
    eyebrowIcon?: React.ReactNode;
    title: React.ReactNode;
    description: string;
    children?: React.ReactNode;
    className?: string;
}

export function HeroBanner({ eyebrow, eyebrowIcon, title, description, children, className }: HeroBannerProps) {
    return (
        <div
            className={cn(
                "relative overflow-hidden rounded-2xl border border-primary/20",
                "bg-gradient-to-br from-primary/8 via-transparent to-accent/8 p-8 backdrop-blur-sm",
                className
            )}
        >
            <GlowOrbsNexus />
            <div className="relative z-10">
                <div className="flex items-center gap-2 text-primary/70 text-xs tracking-widest uppercase mb-2 font-semibold">
                    {eyebrowIcon}
                    <span>{eyebrow}</span>
                </div>
                <h2 className="text-4xl font-bold mb-3">{title}</h2>
                <p className="text-foreground/70 max-w-xl leading-relaxed">{description}</p>
                {children}
            </div>
        </div>
    );
}
