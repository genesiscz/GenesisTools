import type React from "react";
import { WowLogo } from "./wow-logo";

interface FooterLink {
    label: string;
    href: string;
}

interface FooterProps {
    brand?: React.ReactNode;
    links?: FooterLink[];
    copyright?: string;
}

export function Footer({
    brand = (
        <>
            <WowLogo className="size-5 text-muted-foreground/50" />
            <span className="text-sm font-medium text-muted-foreground">Wow</span>
        </>
    ),
    links = [],
    copyright,
}: FooterProps) {
    const copyrightText = copyright ?? `© ${new Date().getFullYear()} Wow. All rights reserved.`;
    return (
        <footer className="border-t border-border mt-20">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
                    <div className="flex items-center gap-2">{brand}</div>
                    {links.length > 0 && (
                        <div className="flex items-center gap-6">
                            {links.map((link) => (
                                <a
                                    key={link.href}
                                    href={link.href}
                                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                                >
                                    {link.label}
                                </a>
                            ))}
                        </div>
                    )}
                    <p className="text-xs text-muted-foreground/50">{copyrightText}</p>
                </div>
            </div>
        </footer>
    );
}
