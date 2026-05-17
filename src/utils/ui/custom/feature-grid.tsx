import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { ArrowRight } from "lucide-react";
import type React from "react";
import {
    FeatureCardNexus,
    type FeatureCardNexusColor,
    FeatureCardNexusContent,
    FeatureCardNexusHeader,
} from "./feature-card";

type IconComponent = React.ElementType<{ className?: string }>;

const colorStyles: Record<FeatureCardNexusColor, { bg: string; icon: string; badge: string }> = {
    cyan: { bg: "bg-cyan-500/10", icon: "text-cyan-400", badge: "bg-cyan-500/20 text-cyan-400" },
    purple: { bg: "bg-purple-500/10", icon: "text-purple-400", badge: "bg-purple-500/20 text-purple-400" },
    amber: { bg: "bg-amber-500/10", icon: "text-amber-400", badge: "bg-amber-500/20 text-amber-400" },
    emerald: { bg: "bg-emerald-500/10", icon: "text-emerald-400", badge: "bg-emerald-500/20 text-emerald-400" },
    rose: { bg: "bg-rose-500/10", icon: "text-rose-400", badge: "bg-rose-500/20 text-rose-400" },
    blue: { bg: "bg-blue-500/10", icon: "text-blue-400", badge: "bg-blue-500/20 text-blue-400" },
    primary: { bg: "bg-primary/10", icon: "text-primary", badge: "bg-primary/20 text-primary" },
    neutral: { bg: "bg-white/5", icon: "text-white/70", badge: "bg-white/10 text-white/70" },
};

export interface FeatureGridItem {
    title: string;
    description: string;
    icon: IconComponent;
    href: string;
    color: FeatureCardNexusColor;
    badge: string;
}

interface FeatureGridProps {
    items: FeatureGridItem[];
    LinkComponent: React.ElementType;
}

export function FeatureGrid({ items, LinkComponent }: FeatureGridProps) {
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((feature, index) => {
                const styles = colorStyles[feature.color];
                const isActive = feature.badge === "Active";
                const Icon = feature.icon;

                return (
                    <LinkComponent key={feature.title} to={feature.href}>
                        <FeatureCardNexus
                            color={feature.color}
                            className="h-full animate-slide-up"
                            style={{ animationDelay: `${index * 50}ms` }}
                        >
                            <FeatureCardNexusHeader className="pb-2">
                                <div className="flex items-start justify-between">
                                    <div className={`p-2.5 rounded-lg ${styles.bg}`}>
                                        <Icon className={`h-5 w-5 ${styles.icon}`} />
                                    </div>
                                    <Badge variant="outline" className={`text-[10px] ${styles.badge} border-0`}>
                                        {feature.badge}
                                    </Badge>
                                </div>
                                <h4 className="text-base font-semibold mt-3">{feature.title}</h4>
                                <p className="text-xs text-muted-foreground leading-relaxed">{feature.description}</p>
                            </FeatureCardNexusHeader>
                            <FeatureCardNexusContent className="pt-0">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className={`p-0 h-auto text-xs ${styles.icon} opacity-0 group-hover:opacity-100 transition-opacity`}
                                    disabled={!isActive}
                                >
                                    {isActive ? "Open" : "Coming Soon"}
                                    {isActive && <ArrowRight className="ml-1 h-3 w-3" />}
                                </Button>
                            </FeatureCardNexusContent>
                        </FeatureCardNexus>
                    </LinkComponent>
                );
            })}
        </div>
    );
}
