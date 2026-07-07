import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ui/components/tooltip";
import { GlowOrbsNexus } from "@ui/custom/glow-orbs";
import { ThemeProvider } from "@ui/theme/provider";
import type { ReactNode } from "react";

export interface NavLink {
    label: string;
    href: string;
    icon?: ReactNode;
    /** Optional decoration rendered to the right of the label (e.g. a count badge) */
    badge?: ReactNode;
}

export interface DashboardLayoutProps {
    /** Title displayed in the header, e.g. "CLARITY::TIMELOG" */
    title: string;
    /** Highlighted portion of the title (after ::), rendered in amber */
    titleAccent?: string;
    /** Icon element rendered next to the title */
    icon?: ReactNode;
    /** Navigation links in the header */
    navLinks?: NavLink[];
    /** Currently active path for nav highlight */
    activePath?: string;
    /** Callback when a nav link is clicked (for SPA routing) */
    onNavigate?: (href: string) => void;
    /** Optional element rendered to the right of the nav (e.g. user chip + logout) */
    rightSlot?: ReactNode;
    /** Main content */
    children: ReactNode;
}

export function DashboardLayout({
    title,
    titleAccent,
    icon,
    navLinks,
    activePath,
    onNavigate,
    rightSlot,
    children,
}: DashboardLayoutProps) {
    const displayTitle = titleAccent ? (
        <>
            {title}
            <span className="text-primary">::</span>
            {titleAccent}
        </>
    ) : (
        title
    );

    return (
        <ThemeProvider variant="nexus">
            <TooltipProvider>
                <div className="min-h-screen bg-background text-foreground relative isolate">
                    {/* Ambient cyber grid — the textured backdrop the dashboard uses */}
                    <div className="fixed inset-0 cyber-grid opacity-[0.35] pointer-events-none -z-10" />

                    {/* Themed glow orbs (primary + accent) for depth */}
                    <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10">
                        <GlowOrbsNexus />
                    </div>

                    {/* Subtle scan lines for the terminal vibe */}
                    <div className="fixed inset-0 scan-lines opacity-[0.04] pointer-events-none z-50" />

                    {/* Header */}
                    <header className="sticky top-0 z-40 bg-background/70 backdrop-blur-2xl border-b border-primary/20 shadow-[0_1px_0_0_rgba(255,255,255,0.03),0_8px_24px_-12px_var(--color-primary)]">
                        <div className="max-w-6xl mx-auto px-3 sm:px-6">
                            <div className="flex h-12 items-center justify-between">
                                {/* Logo / Title */}
                                <button
                                    type="button"
                                    className="flex items-center gap-2 group cursor-pointer shrink-0"
                                    onClick={() => onNavigate?.("/")}
                                >
                                    {icon && (
                                        <div className="p-1 rounded-md bg-primary/10 border border-primary/30 theme-glow-hover group-hover:bg-primary/20 group-hover:border-primary/50 transition-colors">
                                            {icon}
                                        </div>
                                    )}
                                    <span className="font-mono font-bold text-sm tracking-wider text-foreground/90 group-hover:text-foreground transition-colors hidden sm:inline">
                                        {displayTitle}
                                    </span>
                                </button>

                                {/* Navigation */}
                                {navLinks && navLinks.length > 0 && (
                                    <nav className="flex items-center gap-0.5 sm:gap-1 overflow-x-auto flex-nowrap min-w-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                                        {navLinks.map(({ label, href, icon: linkIcon, badge }) => {
                                            const isActive = activePath === href;
                                            return (
                                                <Tooltip key={href}>
                                                    <TooltipTrigger asChild>
                                                        <a
                                                            href={href}
                                                            onClick={(e) => {
                                                                if (onNavigate) {
                                                                    e.preventDefault();
                                                                    onNavigate(href);
                                                                }
                                                            }}
                                                            className={`flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 rounded-md text-xs font-mono tracking-wider transition-all no-underline shrink-0 ${
                                                                isActive
                                                                    ? "bg-primary/15 text-primary border border-primary/40 shadow-[0_0_12px_-2px_var(--color-primary)]"
                                                                    : "text-muted-foreground border border-transparent hover:text-foreground hover:bg-primary/5 hover:border-primary/20"
                                                            }`}
                                                        >
                                                            {linkIcon}
                                                            <span className="hidden sm:inline">{label}</span>
                                                            {badge}
                                                        </a>
                                                    </TooltipTrigger>
                                                    <TooltipContent className="font-mono">{label}</TooltipContent>
                                                </Tooltip>
                                            );
                                        })}
                                    </nav>
                                )}

                                {rightSlot}
                            </div>
                        </div>
                    </header>

                    {/* Main content */}
                    <main className="relative z-10">{children}</main>
                </div>
            </TooltipProvider>
        </ThemeProvider>
    );
}
