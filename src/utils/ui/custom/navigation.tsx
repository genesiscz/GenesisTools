import { cn } from "@ui/lib/utils";
import { useEffect, useState } from "react";
import { WowLogo } from "./wow-logo";

interface NavLink {
    label: string;
    href: string;
}

interface NavigationProps {
    brand?: string;
    links?: NavLink[];
    cta?: { label: string; onClick?: () => void };
    className?: string;
}

/**
 * Fixed top nav with backdrop blur + shadow on scroll.
 * Uses the `.nav-blur` utility class from wow-components.css.
 */
export function Navigation({ brand = "Wow", links = [], cta, className }: NavigationProps) {
    const [scrolled, setScrolled] = useState(false);
    const [mobileOpen, setMobileOpen] = useState(false);

    useEffect(() => {
        const handleScroll = () => setScrolled(window.scrollY > 20);
        handleScroll();
        window.addEventListener("scroll", handleScroll);
        return () => window.removeEventListener("scroll", handleScroll);
    }, []);

    return (
        <nav
            className={cn(
                "fixed top-0 left-0 right-0 z-50 nav-blur transition-shadow duration-300",
                scrolled && "shadow-lg shadow-black/20",
                className
            )}
        >
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="flex items-center justify-between h-16">
                    <div className="flex items-center gap-2">
                        <WowLogo className="size-6 text-foreground" />
                        <span className="text-lg font-semibold text-foreground">{brand}</span>
                    </div>

                    {links.length > 0 && (
                        <div className="hidden lg:flex items-center gap-6">
                            {links.map((link) => (
                                <a
                                    key={link.href}
                                    href={link.href}
                                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                                >
                                    {link.label}
                                </a>
                            ))}
                        </div>
                    )}

                    <div className="flex items-center gap-3">
                        {cta && (
                            <button type="button" onClick={cta.onClick} className="btn-primary hidden sm:inline-flex">
                                {cta.label}
                            </button>
                        )}
                        {links.length > 0 && (
                            <button
                                type="button"
                                className="lg:hidden text-foreground p-2"
                                onClick={() => setMobileOpen((v) => !v)}
                                aria-label="Toggle menu"
                                aria-expanded={mobileOpen}
                                aria-controls="wow-nav-mobile-menu"
                            >
                                <svg
                                    width="20"
                                    height="20"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                >
                                    {mobileOpen ? (
                                        <path d="M18 6L6 18M6 6l12 12" />
                                    ) : (
                                        <path d="M3 12h18M3 6h18M3 18h18" />
                                    )}
                                </svg>
                            </button>
                        )}
                    </div>
                </div>

                {mobileOpen && links.length > 0 && (
                    <div id="wow-nav-mobile-menu" className="lg:hidden pb-4 border-t border-border mt-2">
                        <div className="flex flex-col gap-2 pt-4">
                            {links.map((link) => (
                                <a
                                    key={link.href}
                                    href={link.href}
                                    className="text-sm text-muted-foreground hover:text-foreground px-3 py-2 rounded-lg hover:bg-white/5 transition-colors"
                                    onClick={() => setMobileOpen(false)}
                                >
                                    {link.label}
                                </a>
                            ))}
                            {cta && (
                                <button
                                    type="button"
                                    onClick={cta.onClick}
                                    className="btn-primary mt-2 sm:hidden justify-center"
                                >
                                    {cta.label}
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </nav>
    );
}
