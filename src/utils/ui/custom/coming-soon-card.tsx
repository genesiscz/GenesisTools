import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Bell, Sparkles } from "lucide-react";
import type React from "react";
import {
    FeatureCardNexus,
    type FeatureCardNexusColor,
    FeatureCardNexusContent,
    FeatureCardNexusDescription,
    FeatureCardNexusHeader,
    FeatureCardNexusTitle,
} from "./feature-card";

type IconComponent = React.ElementType<{ className?: string }>;

const tint: Record<
    FeatureCardNexusColor,
    {
        iconText: string;
        iconBox: string;
        badge: string;
        previewBox: string;
        previewIcon: string;
        btn: string;
    }
> = {
    cyan: {
        iconText: "text-cyan-400",
        iconBox: "bg-cyan-500/10 border-cyan-500/20",
        badge: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
        previewBox: "bg-cyan-500/5 border-cyan-500/10",
        previewIcon: "text-cyan-400/60",
        btn: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/30 hover:text-cyan-300",
    },
    purple: {
        iconText: "text-purple-400",
        iconBox: "bg-purple-500/10 border-purple-500/20",
        badge: "bg-purple-500/20 text-purple-400 border-purple-500/30",
        previewBox: "bg-purple-500/5 border-purple-500/10",
        previewIcon: "text-purple-400/60",
        btn: "bg-purple-500/20 text-purple-400 border-purple-500/30 hover:bg-purple-500/30 hover:text-purple-300",
    },
    amber: {
        iconText: "text-amber-400",
        iconBox: "bg-amber-500/10 border-amber-500/20",
        badge: "bg-amber-500/20 text-amber-400 border-amber-500/30",
        previewBox: "bg-amber-500/5 border-amber-500/10",
        previewIcon: "text-amber-400/60",
        btn: "bg-amber-500/20 text-amber-400 border-amber-500/30 hover:bg-amber-500/30 hover:text-amber-300",
    },
    emerald: {
        iconText: "text-emerald-400",
        iconBox: "bg-emerald-500/10 border-emerald-500/20",
        badge: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
        previewBox: "bg-emerald-500/5 border-emerald-500/10",
        previewIcon: "text-emerald-400/60",
        btn: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/30 hover:text-emerald-300",
    },
    rose: {
        iconText: "text-rose-400",
        iconBox: "bg-rose-500/10 border-rose-500/20",
        badge: "bg-rose-500/20 text-rose-400 border-rose-500/30",
        previewBox: "bg-rose-500/5 border-rose-500/10",
        previewIcon: "text-rose-400/60",
        btn: "bg-rose-500/20 text-rose-400 border-rose-500/30 hover:bg-rose-500/30 hover:text-rose-300",
    },
    blue: {
        iconText: "text-blue-400",
        iconBox: "bg-blue-500/10 border-blue-500/20",
        badge: "bg-blue-500/20 text-blue-400 border-blue-500/30",
        previewBox: "bg-blue-500/5 border-blue-500/10",
        previewIcon: "text-blue-400/60",
        btn: "bg-blue-500/20 text-blue-400 border-blue-500/30 hover:bg-blue-500/30 hover:text-blue-300",
    },
    primary: {
        iconText: "text-primary",
        iconBox: "bg-primary/10 border-primary/20",
        badge: "bg-primary/20 text-primary border-primary/30",
        previewBox: "bg-primary/5 border-primary/10",
        previewIcon: "text-primary/60",
        btn: "bg-primary/20 text-primary border-primary/30 hover:bg-primary/30 hover:text-primary",
    },
    neutral: {
        iconText: "text-white/70",
        iconBox: "bg-white/5 border-white/10",
        badge: "bg-white/10 text-white/70 border-white/15",
        previewBox: "bg-white/5 border-white/10",
        previewIcon: "text-white/50",
        btn: "bg-white/10 text-white/70 border-white/15 hover:bg-white/15 hover:text-white",
    },
};

interface ComingSoonCardProps {
    color: FeatureCardNexusColor;
    icon: IconComponent;
    title: string;
    description: string;
    features: { icon: IconComponent; label: string }[];
    notifyLabel?: string;
    ornament?: React.ReactNode;
}

export function ComingSoonCard({
    color,
    icon: Icon,
    title,
    description,
    features,
    notifyLabel = "Notify Me When Available",
    ornament,
}: ComingSoonCardProps) {
    const t = tint[color];

    return (
        <div className="flex items-center justify-center min-h-[60vh]">
            <FeatureCardNexus color={color} className="max-w-lg w-full">
                <FeatureCardNexusHeader className="text-center">
                    <div className="flex justify-center mb-4">
                        <div className="relative">
                            <div className={`p-4 rounded-2xl border ${t.iconBox}`}>
                                <Icon className={`h-12 w-12 ${t.iconText}`} />
                            </div>
                            {ornament ?? (
                                <div className="absolute -top-1 -right-1">
                                    <Sparkles className={`h-4 w-4 ${t.iconText} animate-pulse`} />
                                </div>
                            )}
                        </div>
                    </div>

                    <Badge variant="outline" className={`mx-auto mb-3 text-xs ${t.badge}`}>
                        Coming Soon
                    </Badge>

                    <FeatureCardNexusTitle>{title}</FeatureCardNexusTitle>
                    <FeatureCardNexusDescription className="max-w-sm mx-auto">
                        {description}
                    </FeatureCardNexusDescription>
                </FeatureCardNexusHeader>

                <FeatureCardNexusContent className="space-y-6">
                    <div className="grid grid-cols-3 gap-3">
                        {features.map((feature) => {
                            const FeatureIcon = feature.icon;

                            return (
                                <div
                                    key={feature.label}
                                    className={`flex flex-col items-center gap-2 p-3 rounded-lg border ${t.previewBox}`}
                                >
                                    <FeatureIcon className={`h-5 w-5 ${t.previewIcon}`} />
                                    <span className="text-[10px] text-muted-foreground text-center">
                                        {feature.label}
                                    </span>
                                </div>
                            );
                        })}
                    </div>

                    <div className="flex flex-col items-center gap-3">
                        <Button className={`border ${t.btn}`}>
                            <Bell className="h-4 w-4 mr-2" />
                            {notifyLabel}
                        </Button>
                        <p className="text-[10px] text-muted-foreground">
                            Be the first to know when this feature launches
                        </p>
                    </div>
                </FeatureCardNexusContent>
            </FeatureCardNexus>
        </div>
    );
}
