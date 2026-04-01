import { createFileRoute } from "@tanstack/react-router";
import { Star } from "lucide-react";

export const Route = createFileRoute("/watchlist")({
    component: WatchlistPage,
});

function WatchlistPage() {
    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30">
                    <Star className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                    <h1 className="text-xl font-mono font-bold text-gray-200">Watchlist</h1>
                    <p className="text-xs text-gray-500 font-mono">Track saved properties and monitor changes</p>
                </div>
            </div>
            <div className="border border-white/5 rounded-lg p-8 text-center">
                <p className="text-sm text-gray-500 font-mono">Watchlist management coming soon</p>
            </div>
        </div>
    );
}
