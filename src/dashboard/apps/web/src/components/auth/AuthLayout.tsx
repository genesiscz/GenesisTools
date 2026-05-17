import { Link } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import type { ReactNode } from "react";

interface AuthLayoutProps {
    children: ReactNode;
}

export function AuthLayout({ children }: AuthLayoutProps) {
    return (
        <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-[#030308]">
            {/* Animated background gradient orbs */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute top-1/4 -left-32 w-96 h-96 bg-amber-500/20 rounded-full blur-[128px] animate-pulse" />
                <div
                    className="absolute bottom-1/4 -right-32 w-96 h-96 bg-cyan-500/10 rounded-full blur-[128px] animate-pulse"
                    style={{ animationDelay: "1s" }}
                />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-amber-500/5 rounded-full blur-[200px]" />
            </div>

            {/* Cyberpunk grid background */}
            <div className="absolute inset-0 cyber-grid opacity-30" />

            {/* Scan lines effect */}
            <div className="absolute inset-0 scan-lines pointer-events-none" />

            {/* Time ripple effect */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="relative w-[700px] h-[700px]">
                    <div className="absolute inset-0 rounded-full border border-amber-500/10 animate-ripple" />
                    <div className="absolute inset-0 rounded-full border border-amber-500/10 animate-ripple-delayed" />
                    <div className="absolute inset-0 rounded-full border border-amber-500/10 animate-ripple-delayed-2" />
                </div>
            </div>

            {/* Main content */}
            <div className="relative z-10 w-full max-w-md px-6" suppressHydrationWarning>
                {/* Logo */}
                <div className="text-center mb-8 animate-fade-in-up">
                    <Link to="/" className="inline-flex items-center gap-3 group">
                        <div className="relative">
                            <div className="absolute inset-0 blur-lg bg-amber-500/40 group-hover:bg-amber-500/60 transition-colors" />
                            <div className="relative h-12 w-12 rounded-xl bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center neon-glow">
                                <Clock className="h-6 w-6 text-black" />
                            </div>
                        </div>
                        <span className="text-2xl font-bold gradient-text">Dashboard</span>
                    </Link>
                </div>

                {/* Card container */}
                <div className="animate-fade-in-up delay-100">
                    <div className="relative rounded-2xl glass-card p-8 neon-border tech-corner">
                        {/* Inner glow effect */}
                        <div className="absolute inset-0 rounded-2xl bg-gradient-to-b from-amber-500/5 to-transparent pointer-events-none" />

                        {/* Content */}
                        <div className="relative">{children}</div>
                    </div>
                </div>

                {/* Footer */}
                <div className="text-center mt-6 text-sm text-gray-500 animate-fade-in-up delay-200">
                    <p>
                        By continuing, you agree to our{" "}
                        <Link to="/" className="text-amber-500 hover:underline">
                            Terms of Service
                        </Link>{" "}
                        and{" "}
                        <Link to="/" className="text-amber-500 hover:underline">
                            Privacy Policy
                        </Link>
                    </p>
                </div>
            </div>
        </div>
    );
}
