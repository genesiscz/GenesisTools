import { cn } from "@ui/lib/utils";
import type React from "react";

type IconComponent = React.ElementType<{ className?: string }>;

export interface TabDef<V extends string> {
    value: V;
    label: string;
    icon?: IconComponent;
    activeColor?: string;
}

interface TabBarProps<V extends string> {
    tabs: TabDef<V>[];
    activeTab: V;
    onTabChange: (value: V) => void;
    counts?: Partial<Record<V, number>>;
    theme?: "purple" | "tinted";
    className?: string;
}

export function TabBar<V extends string>({
    tabs,
    activeTab,
    onTabChange,
    counts,
    theme = "purple",
    className,
}: TabBarProps<V>) {
    return (
        <div className={cn("flex items-center gap-1 p-1 rounded-lg bg-white/5 border border-white/10", className)}>
            {tabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.value;
                const count = counts?.[tab.value];
                const activeClass = theme === "purple" ? "bg-purple-500/20 text-purple-300" : "bg-white/10 shadow-sm";
                const activeColor = theme === "tinted" && tab.activeColor ? tab.activeColor : "";

                return (
                    <button
                        key={tab.value}
                        type="button"
                        onClick={() => onTabChange(tab.value)}
                        className={cn(
                            "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                            isActive ? activeClass : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                        )}
                    >
                        {Icon && <Icon className={cn("h-4 w-4", isActive && activeColor)} />}
                        <span className={cn("hidden sm:inline", isActive && activeColor)}>{tab.label}</span>
                        {count !== undefined && (
                            <span
                                className={cn(
                                    "text-xs px-1.5 rounded-full",
                                    isActive
                                        ? theme === "purple"
                                            ? "bg-purple-500/30 text-purple-200"
                                            : "bg-white/15"
                                        : "bg-white/10"
                                )}
                            >
                                {count}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}
