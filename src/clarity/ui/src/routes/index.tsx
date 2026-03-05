import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Badge } from "@ui/components/badge";
import { Link2, ArrowDownToLine, ArrowUpFromLine, Settings } from "lucide-react";
import { useRouter } from "@tanstack/react-router";

export function IndexPage() {
    const router = useRouter();

    const quickActions = [
        {
            label: "Mappings",
            description: "Link ADO work items to Clarity tasks",
            icon: <Link2 className="w-5 h-5" />,
            href: "/mappings",
        },
        {
            label: "Export",
            description: "View ADO timelog entries by month",
            icon: <ArrowDownToLine className="w-5 h-5" />,
            href: "/export",
        },
        {
            label: "Import",
            description: "Fill Clarity timesheets from ADO data",
            icon: <ArrowUpFromLine className="w-5 h-5" />,
            href: "/import",
        },
        {
            label: "Settings",
            description: "Configure auth and connection",
            icon: <Settings className="w-5 h-5" />,
            href: "/settings",
        },
    ];

    return (
        <div className="max-w-6xl mx-auto px-6 py-8">
            <div className="mb-8">
                <h1 className="text-2xl font-mono font-bold text-gray-200 mb-2">
                    ADO <span className="text-amber-500">&harr;</span> Clarity Sync
                </h1>
                <p className="text-sm text-gray-500 font-mono">
                    Manage timelog synchronization between Azure DevOps and CA PPM Clarity
                </p>
            </div>

            {/* Status card */}
            <Card className="mb-8 border-amber-500/20">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-gray-400 flex items-center gap-2">
                        SYSTEM STATUS
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                            <span className="text-xs font-mono text-gray-400">CLARITY</span>
                            <Badge variant="outline" className="text-xs">
                                Check Settings
                            </Badge>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                            <span className="text-xs font-mono text-gray-400">ADO TIMELOG</span>
                            <Badge variant="outline" className="text-xs">
                                Check Settings
                            </Badge>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Quick actions grid */}
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
