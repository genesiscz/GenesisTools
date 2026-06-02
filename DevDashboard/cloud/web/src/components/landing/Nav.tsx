import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { NAV_LINKS } from "@/content/copy";
import { ArrowRight, LogoMark } from "./icons";

export function Nav() {
    const [open, setOpen] = useState(false);

    return (
        <>
            <header className="fixed inset-x-0 top-0 z-40 flex justify-center px-4">
                <nav className="mt-6 w-full max-w-3xl">
                    <div className="flex items-center justify-between gap-4 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 pl-5 backdrop-blur-2xl shadow-[0_8px_40px_-12px_rgba(0,0,0,0.7)]">
                        <a href="#top" className="flex items-center gap-2.5 shrink-0">
                            <span className="relative flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400/20 to-violet-500/20 ring-1 ring-white/10">
                                <LogoMark className="h-4 w-4 text-emerald-300" />
                            </span>
                            <span className="font-display text-[15px] font-semibold tracking-tight text-zinc-100">
                                DevDashboard
                            </span>
                        </a>

                        <div className="hidden items-center gap-1 text-sm text-zinc-400 md:flex">
                            {NAV_LINKS.map((link) => (
                                <a
                                    key={link.href}
                                    href={link.href}
                                    className="rounded-full px-3.5 py-1.5 transition-colors duration-500 ease-silk hover:bg-white/[0.06] hover:text-zinc-100"
                                >
                                    {link.label}
                                </a>
                            ))}
                        </div>

                        <Link
                            to="/signup"
                            className="group hidden shrink-0 items-center gap-2 rounded-full bg-zinc-100 py-1.5 pl-4 pr-1.5 text-sm font-medium text-zinc-900 transition-transform duration-500 ease-silk active:scale-[0.97] md:flex"
                        >
                            <span>Pair your Mac</span>
                            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-900/10 transition-transform duration-500 ease-silk group-hover:translate-x-0.5">
                                <ArrowRight className="h-3.5 w-3.5 text-zinc-900" />
                            </span>
                        </Link>

                        <button
                            type="button"
                            aria-label={open ? "Close menu" : "Open menu"}
                            onClick={() => setOpen((v) => !v)}
                            className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] ring-1 ring-white/10 md:hidden"
                        >
                            <span
                                className={`absolute h-px w-4 bg-zinc-200 transition-transform duration-500 ease-silk ${open ? "rotate-45" : "-translate-y-1"}`}
                            />
                            <span
                                className={`absolute h-px w-4 bg-zinc-200 transition-transform duration-500 ease-silk ${open ? "-rotate-45" : "translate-y-1"}`}
                            />
                        </button>
                    </div>
                </nav>
            </header>

            <div
                id="mobileMenu"
                className={`fixed inset-0 z-30 flex-col items-center justify-center gap-2 bg-black/85 backdrop-blur-3xl ${open ? "flex open" : "hidden"}`}
            >
                {NAV_LINKS.map((link, i) => (
                    <a
                        key={link.href}
                        href={link.href}
                        onClick={() => setOpen(false)}
                        className="m-link font-display text-3xl font-semibold text-zinc-100"
                        style={{ transitionDelay: `${80 + i * 60}ms` }}
                    >
                        {link.label}
                    </a>
                ))}
                <Link
                    to="/signup"
                    onClick={() => setOpen(false)}
                    className="m-link mt-6 flex items-center gap-2 rounded-full bg-zinc-100 py-3 pl-6 pr-2 font-medium text-zinc-900"
                    style={{ transitionDelay: "320ms" }}
                >
                    Pair your Mac
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900/10">
                        <ArrowRight className="h-4 w-4" />
                    </span>
                </Link>
            </div>
        </>
    );
}
