import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Card, CardContent } from "@ui/components/card";
import { Clock, GitCompare, Search, Star } from "lucide-react";

export const Route = createFileRoute("/")({
    component: IndexPage,
});

const quickActions = [
    {
        label: "Analyze",
        description: "Run market analysis for a property or district",
        icon: <Search className="w-5 h-5" />,
        href: "/analyze",
    },
    {
        label: "Compare",
        description: "Side-by-side district comparison with trends",
        icon: <GitCompare className="w-5 h-5" />,
        href: "/compare",
    },
    {
        label: "Watchlist",
        description: "Track saved properties and monitor changes",
        icon: <Star className="w-5 h-5" />,
        href: "/watchlist",
    },
    {
        label: "History",
        description: "Browse past analysis results and snapshots",
        icon: <Clock className="w-5 h-5" />,
        href: "/history",
    },
];

function IndexPage() {
    const router = useRouter();

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
            <div className="mb-8">
                <h1 className="text-xl sm:text-2xl font-mono font-bold text-gray-200 mb-2">
                    Real Estate <span className="text-amber-500">Analysis</span>
                </h1>
                <p className="text-sm text-gray-500 font-mono">
                    Czech real estate market data from REAS, Sreality, and MF cenova mapa
                </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {quickActions.map((action) => (
                    <button
                        key={action.href}
                        type="button"
                        onClick={() => router.navigate({ to: action.href })}
                        className="text-left"
                    >
                        <Card className="border-white/5 hover:border-amber-500/30 transition-all hover:neon-glow cursor-pointer h-full">
                            <CardContent className="p-5">
                                <div className="flex items-start gap-4">
                                    <div className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400">
                                        {action.icon}
                                    </div>
                                    <div>
                                        <h3 className="font-mono font-bold text-sm text-gray-200 mb-1">
                                            {action.label}
                                        </h3>
                                        <p className="text-xs text-gray-500">{action.description}</p>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    </button>
                ))}
            </div>
        </div>
    );
}
