export function RouteError({ error, reset }: { error: Error; reset: () => void }) {
    return (
        <main className="relative z-10 mx-auto flex min-h-[80dvh] max-w-xl flex-col items-center justify-center px-6 text-center">
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-amber-300/80">Something broke</span>
            <h1 className="mt-4 font-display text-3xl font-semibold text-zinc-50">An unexpected error occurred</h1>
            <p className="mt-3 max-w-md font-mono text-sm text-zinc-500">{error.message}</p>
            <button
                type="button"
                onClick={reset}
                className="mt-8 rounded-full bg-zinc-100 px-6 py-2.5 text-sm font-medium text-zinc-900 transition-transform duration-500 ease-silk active:scale-[0.97]"
            >
                Try again
            </button>
        </main>
    );
}
