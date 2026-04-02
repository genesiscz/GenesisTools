import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { Button } from "@ui/components/button";
import { DownloadIcon } from "lucide-react";
import { useState } from "react";

interface ExportButtonProps {
    data: DashboardExport;
}

export function ExportButton({ data }: ExportButtonProps) {
    const [exporting, setExporting] = useState(false);

    const handleExport = async () => {
        setExporting(true);

        try {
            const response = await fetch("/api/export-pdf", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: globalThis.JSON.stringify(data),
            });

            if (!response.ok) {
                throw new Error("Failed to export PDF");
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "reas-report.pdf";
            link.click();
            URL.revokeObjectURL(url);
        } finally {
            setExporting(false);
        }
    };

    return (
        <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
            <DownloadIcon data-icon="inline-start" />
            {exporting ? "Exporting..." : "Export PDF"}
        </Button>
    );
}
