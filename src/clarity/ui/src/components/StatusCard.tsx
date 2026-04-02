import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { AlertTriangle, Shield } from "lucide-react";
import type { GranularStatus } from "../server/settings";

async function fetchGranularStatus(): Promise<GranularStatus> {
    const res = await fetch("/api/granular-status");

    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `Failed to fetch status (${res.status})`);
    }

    return res.json();
}

interface StatusCardProps {
    /** Compact mode for homepage — fewer details */
    compact?: boolean;
}

function StatusDot({ color }: { color: "green" | "red" | "amber" }) {
    const colorClass = {
        green: "bg-green-500",
        red: "bg-red-500",
        amber: "bg-amber-500",
    }[color];

    return <span className={`w-2 h-2 rounded-full inline-block ${colorClass}`} />;
}

function AuthBadge({ hasAuth }: { hasAuth: boolean }) {
    return hasAuth ? (
        <Badge variant="outline" className="text-xs border-green-500/30 text-green-400">
            Active
        </Badge>
    ) : (
        <Badge variant="outline" className="text-xs border-red-500/30 text-red-400">
            Missing
        </Badge>
    );
}

function clarityDotColor(clarity: GranularStatus["clarity"]): "green" | "red" {
    return clarity.configured && clarity.hasAuth ? "green" : "red";
}

function adoDotColor(ado: GranularStatus["ado"]): "green" | "amber" | "red" {
    if (!ado.configured) {
        return "red";
    }

    return ado.hasOrgId ? "green" : "amber";
}

function timelogDotColor(timelog: GranularStatus["timelog"]): "green" | "amber" | "red" {
    if (timelog.configured && timelog.defaultUser) {
        return "green";
    }

    if (timelog.configured || timelog.hasFunctionsKey) {
        return "amber";
    }

    return "red";
}

function DirectoryWarning({ projectCwd }: { projectCwd: string }) {
    return (
        <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 mb-4">
            <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <div className="text-xs text-amber-300/80">
                <span className="font-mono text-amber-300">{projectCwd}</span>
                <br />
                Config is read from this directory. Run <span className="font-mono">tools clarity ui</span> from the
                same folder where you ran <span className="font-mono">tools azure-devops configure</span>.
            </div>
        </div>
    );
}

function ClaritySection({ clarity }: { clarity: GranularStatus["clarity"] }) {
    return (
        <div className="space-y-1">
            <div className="flex items-center gap-2">
                <StatusDot color={clarityDotColor(clarity)} />
                <span className="text-sm font-mono text-gray-300">Clarity PPM</span>
            </div>

            {clarity.configured ? (
                <div className="ml-4 space-y-1">
                    {clarity.baseUrl && <div className="text-xs font-mono text-gray-400">{clarity.baseUrl}</div>}
                    <div className="flex items-center gap-2 text-xs font-mono text-gray-400">
                        Auth: <AuthBadge hasAuth={clarity.hasAuth} />
                    </div>
                    <div className="text-xs font-mono text-gray-400">Mappings: {clarity.mappingsCount}</div>
                    {clarity.uniqueName && <div className="text-xs font-mono text-gray-400">{clarity.uniqueName}</div>}
                </div>
            ) : (
                <div className="ml-4 text-xs font-mono text-gray-500">Not configured — paste a cURL command below</div>
            )}
        </div>
    );
}

function AdoSection({ ado }: { ado: GranularStatus["ado"] }) {
    return (
        <div className="space-y-1">
            <div className="flex items-center gap-2">
                <StatusDot color={adoDotColor(ado)} />
                <span className="text-sm font-mono text-gray-300">Azure DevOps</span>
            </div>

            {ado.configured ? (
                <div className="ml-4 space-y-1">
                    <div className="text-xs font-mono text-gray-400">Org: {ado.org}</div>
                    <div className="text-xs font-mono text-gray-400">Project: {ado.project}</div>
                    {!ado.hasOrgId && (
                        <div className="text-xs font-mono text-amber-400/80">
                            Org ID missing — reconfigure below to fix TimeLog
                        </div>
                    )}
                </div>
            ) : (
                <div className="ml-4 text-xs font-mono text-amber-400/80">
                    Not configured — set up below or run:{" "}
                    <span className="font-mono">tools azure-devops configure &lt;url&gt;</span>
                </div>
            )}
        </div>
    );
}

function TimelogSection({ timelog }: { timelog: GranularStatus["timelog"] }) {
    const dotColor = timelogDotColor(timelog);

    return (
        <div className="space-y-1">
            <div className="flex items-center gap-2">
                <StatusDot color={dotColor} />
                <span className="text-sm font-mono text-gray-300">TimeLog</span>
            </div>

            {timelog.configured && timelog.defaultUser ? (
                <div className="ml-4 space-y-1">
                    <div className="text-xs font-mono text-gray-400">API key: configured</div>
                    <div className="text-xs font-mono text-gray-400">
                        Default user: {timelog.defaultUser.userName} ({timelog.defaultUser.userEmail})
                    </div>
                </div>
            ) : timelog.configured || timelog.hasFunctionsKey ? (
                <div className="ml-4 space-y-1">
                    <div className="text-xs font-mono text-gray-400">API key: configured</div>
                    <div className="text-xs font-mono text-gray-400">Default user: not set</div>
                </div>
            ) : (
                <div className="ml-4 text-xs font-mono text-amber-400/80">
                    Not configured — set up below or run:{" "}
                    <span className="font-mono">tools azure-devops timelog configure</span>
                </div>
            )}
        </div>
    );
}

function CompactStatusCard({ status }: { status: GranularStatus }) {
    const anyUnconfigured =
        clarityDotColor(status.clarity) === "red" ||
        adoDotColor(status.ado) === "red" ||
        timelogDotColor(status.timelog) === "red";

    return (
        <Card className="border-amber-500/20">
            <CardHeader className="pb-3">
                <CardTitle className="text-sm font-mono text-gray-400 flex items-center gap-2">System status</CardTitle>
            </CardHeader>
            <CardContent>
                <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                        <div className="flex items-center gap-2">
                            <StatusDot color={clarityDotColor(status.clarity)} />
                            <span className="text-xs font-mono text-gray-400">Clarity</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <StatusDot color={adoDotColor(status.ado)} />
                            <span className="text-xs font-mono text-gray-400">ADO</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <StatusDot color={timelogDotColor(status.timelog)} />
                            <span className="text-xs font-mono text-gray-400">TimeLog</span>
                        </div>

                        {anyUnconfigured && (
                            <a
                                href="/settings"
                                className="text-xs font-mono text-amber-400 hover:text-amber-300 transition-colors"
                            >
                                Configure &rarr;
                            </a>
                        )}
                    </div>

                    <div className="text-xs font-mono text-gray-500/60">{status.projectCwd}</div>
                </div>
            </CardContent>
        </Card>
    );
}

export function StatusCard({ compact }: StatusCardProps) {
    const {
        data: status,
        isLoading,
        error,
    } = useQuery({
        queryKey: ["granular-status"],
        queryFn: fetchGranularStatus,
        staleTime: 30_000,
    });

    if (isLoading) {
        return (
            <Card className="border-amber-500/20">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-gray-400 flex items-center gap-2">
                        <Shield className="w-4 h-4" />
                        System status
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="space-y-3">
                        <Skeleton variant="line" />
                        <Skeleton variant="line" />
                    </div>
                </CardContent>
            </Card>
        );
    }

    if (error) {
        return (
            <Card className="border-red-500/20">
                <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono text-gray-400 flex items-center gap-2">
                        <Shield className="w-4 h-4" />
                        System status
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="text-red-400 font-mono text-sm">
                        {error instanceof Error ? error.message : "Failed to fetch status"}
                    </div>
                </CardContent>
            </Card>
        );
    }

    if (!status) {
        return null;
    }

    if (compact) {
        return <CompactStatusCard status={status} />;
    }

    return (
        <Card className="border-amber-500/20">
            <CardHeader className="pb-3">
                <CardTitle className="text-sm font-mono text-gray-400 flex items-center gap-2">
                    <Shield className="w-4 h-4" />
                    Configuration status
                </CardTitle>
            </CardHeader>
            <CardContent>
                <DirectoryWarning projectCwd={status.projectCwd} />
                <div className="space-y-4">
                    <ClaritySection clarity={status.clarity} />
                    <AdoSection ado={status.ado} />
                    <TimelogSection timelog={status.timelog} />
                </div>
            </CardContent>
        </Card>
    );
}
