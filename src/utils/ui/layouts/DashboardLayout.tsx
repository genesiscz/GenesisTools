import type { ReactNode } from "react";

export interface NavLink {
    label: string;
    href: string;
    icon?: ReactNode;
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
    children,
}: DashboardLayoutProps) {
    const displayTitle = titleAccent ? (
        <>
            {title}
            <span className="text-amber-500">::</span>
            {titleAccent}
        </>
    ) : (
        title
    );

    return (
        <div className="cyberpunk min-h-screen bg-background text-foreground relative">
            {/* Ambient glow effects */}
            <div className="fixed inset-0 pointer-events-none z-0">
                <div className="absolute top-0 left-1/4 w-96 h-96 bg-amber-500/5 rounded-full blur-3xl" />
                <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-cyan-500/5 rounded-full blur-3xl" />
            </div>

            {/* Scan lines overlay */}
            <div className="fixed inset-0 scan-lines opacity-[0.02] pointer-events-none z-50" />

            {/* Header */}
            <header className="sticky top-0 z-40 glass-card border-b border-amber-500/20">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="flex h-12 items-center justify-between">
                        {/* Logo / Title */}
                        <div className="flex items-center gap-2 group">
                            {icon && (
                                <div className="p-1 rounded bg-amber-500/10 border border-amber-500/30 group-hover:neon-glow transition-all">
                                    {icon}
                                </div>
                            )}
                            <span className="font-mono font-bold text-sm text-gray-300 tracking-wider">
                                {displayTitle}
                            </span>
                        </div>

                        {/* Navigation */}
                        {navLinks && navLinks.length > 0 && (
                            <nav className="flex items-center gap-1">
                                {navLinks.map(({ label, href, icon: linkIcon }) => {
                                    const isActive = activePath === href;
                                    return (
                                        <button
                                            key={href}
                                            type="button"
                                            onClick={() => onNavigate?.(href)}
                                            className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-mono tracking-wider transition-all ${
                                                isActive
                                                    ? "bg-amber-500/10 text-amber-400 border border-amber-500/30 neon-glow"
                                                    : "text-gray-500 hover:text-gray-300 hover:bg-white/5"
                                            }`}
                                        >
                                            {linkIcon}
                                            {label}
                                        </button>
                                    );
                                })}
                            </nav>
                        )}
                    </div>
                </div>
            </header>

            {/* Main content */}
            <main className="relative z-10">{children}</main>
        </div>
    );
}
