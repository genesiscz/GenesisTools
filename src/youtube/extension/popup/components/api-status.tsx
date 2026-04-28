import { Badge } from "@app/utils/ui/components/badge";

export function ApiStatus({ status }: { status: "unknown" | "ok" | "down" }) {
    if (status === "ok") {
        return <Badge variant="cyber-secondary">Connected</Badge>;
    }

    if (status === "down") {
        return <Badge variant="destructive">Offline</Badge>;
    }

    return <Badge variant="outline">Not checked</Badge>;
}
