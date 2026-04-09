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
            <span className="text-primary">::</span>
            {titleAccent}
        </>
    ) : (
        title
    );

    return (
        <div className="min-h-screen bg-background text-foreground relative">
            {/* Ambient glow effects */}
            <div className="fixed inset-0 pointer-events-none z-0">
                <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
                <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-secondary/5 rounded-full blur-3xl" />
            </div>

            {/* Scan lines overlay */}
            <div className="fixed inset-0 scan-lines opacity-[0.02] pointer-events-none z-50" />

            {/* Header */}
            <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl border-b border-primary/20">
                <div className="max-w-6xl mx-auto px-3 sm:px-6">
                    <div className="flex h-12 items-center justify-between">
                        {/* Logo / Title */}
                        <button
                            type="button"
                            className="flex items-center gap-2 group cursor-pointer shrink-0"
                            onClick={() => onNavigate?.("/")}
                            onKeyDown={(e) => e.key === "Enter" && onNavigate?.("/")}
                        >
                            {icon && (
                                <div className="p-1 rounded bg-primary/10 border border-primary/30 transition-all">
                                    {icon}
                                </div>
                            )}
                            <span className="font-mono font-bold text-sm text-muted-foreground tracking-wider group-hover:text-foreground transition-colors hidden sm:inline">
                                {displayTitle}
                            </span>
                        </button>

                        {/* Navigation */}
                        {navLinks && navLinks.length > 0 && (
                            <nav className="flex items-center gap-0.5 sm:gap-1">
                                {navLinks.map(({ label, href, icon: linkIcon }) => {
                                    const isActive = activePath === href;
                                    return (
                                        <a
                                            key={href}
                                            href={href}
                                            onClick={(e) => {
                                                if (onNavigate) {
                                                    e.preventDefault();
                                                    onNavigate(href);
                                                }
                                            }}
                                            className={`flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 rounded text-xs font-mono tracking-wider transition-all no-underline ${
                                                isActive
                                                    ? "bg-primary/10 text-primary border border-primary/30"
                                                    : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                                            }`}
                                            title={label}
                                        >
                                            {linkIcon}
                                            <span className="hidden sm:inline">{label}</span>
                                        </a>
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
