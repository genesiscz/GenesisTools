import { Link } from "@tanstack/react-router";

export function RouteNotFound() {
    return (
        <main className="relative z-10 mx-auto flex min-h-[80dvh] max-w-xl flex-col items-center justify-center px-6 text-center">
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-emerald-300/80">404</span>
            <h1 className="mt-4 font-display text-4xl font-semibold text-zinc-50">Page not found</h1>
            <p className="mt-3 max-w-md text-sm text-zinc-500">
                The page you are looking for doesn't exist or has moved.
            </p>
            <Link
                to="/"
                className="mt-8 rounded-full bg-zinc-100 px-6 py-2.5 text-sm font-medium text-zinc-900 transition-transform duration-500 ease-silk active:scale-[0.97]"
            >
                Back home
            </Link>
        </main>
    );
}
