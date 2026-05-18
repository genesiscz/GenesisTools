import { isDashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { exportDashboardToPdf } from "@app/Internal/commands/reas/lib/pdf-export";
import { apiHandler, jsonBody } from "@app/Internal/commands/reas/ui/src/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/export-pdf")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                if (!isDashboardExport(body)) {
                    return Response.json({ error: "Invalid dashboard export payload" }, { status: 400 });
                }

                const pdf = await exportDashboardToPdf(body);
                const responseBody = new ArrayBuffer(pdf.byteLength);
                new Uint8Array(responseBody).set(pdf);

                return new Response(responseBody, {
                    headers: {
                        "Content-Type": "application/pdf",
                        "Content-Disposition": 'attachment; filename="reas-report.pdf"',
                    },
                });
            }),
        },
    },
});
