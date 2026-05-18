import type { ReactNode } from "react";

interface AuthLayoutProps {
    /** Brand name shown next to the logo (rendered as gradient text). */
    brand: string;
    /** Logo icon element (e.g. a lucide icon sized h-6 w-6). */
    icon: ReactNode;
    /** Optional footer (terms/links/tagline). Rendered muted under the card. */
    footer?: ReactNode;
    children: ReactNode;
}

/**
 * Shared branded auth shell — ambient grid + glow orbs + glass card, fully
 * token-driven so it follows whatever theme the host app sets (`.cyberpunk`,
 * `.wow`, …). Generalized from the dashboard's local auth layout so every tool
 * gets the same login/register quality instead of a bare card on a void.
 */
export function AuthLayout({ brand, icon, footer, children }: AuthLayoutProps) {
    return (
        <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-background">
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/20 rounded-full blur-[128px] animate-pulse" />
                <div
                    className="absolute bottom-1/4 -right-32 w-96 h-96 bg-accent/10 rounded-full blur-[128px] animate-pulse"
                    style={{ animationDelay: "1s" }}
                />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[200px]" />
            </div>

            <div className="absolute inset-0 cyber-grid opacity-30 pointer-events-none" />
            <div className="absolute inset-0 scan-lines opacity-[0.04] pointer-events-none" />

            <div className="relative z-10 w-full max-w-md px-6" suppressHydrationWarning>
                <div className="text-center mb-8">
                    <div className="inline-flex items-center gap-3 group">
                        <div className="relative">
                            <div className="absolute inset-0 blur-lg bg-primary/40 group-hover:bg-primary/60 transition-colors" />
                            <div className="relative h-12 w-12 rounded-xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center neon-glow">
                                {icon}
                            </div>
                        </div>
                        <span className="text-2xl font-bold gradient-text">{brand}</span>
                    </div>
                </div>

                <div className="relative rounded-2xl glass-card p-8 neon-border">
                    <div className="absolute inset-0 rounded-2xl bg-gradient-to-b from-primary/5 to-transparent pointer-events-none" />
                    <div className="relative">{children}</div>
                </div>

                {footer && <div className="text-center mt-6 text-sm text-muted-foreground">{footer}</div>}
            </div>
        </div>
    );
}
