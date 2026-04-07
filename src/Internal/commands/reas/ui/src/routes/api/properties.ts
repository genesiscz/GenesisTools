import {
    getAllPropertiesWithHistory,
    getPropertyImportDraft,
    refreshPropertyAnalysis,
} from "@app/Internal/commands/reas/lib/property-service";
import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, jsonBody } from "../../server/api-utils";

export const Route = createFileRoute("/api/properties")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const importUrl = url.searchParams.get("listingUrl")?.trim();

                if (importUrl) {
                    const result = getPropertyImportDraft(importUrl);

                    if (!result) {
                        return Response.json(
                            {
                                error: "Listing URL was not found in the local cache yet. Refresh analysis first to ingest it.",
                            },
                            { status: 404 }
                        );
                    }

                    return Response.json(result);
                }

                if (url.searchParams.get("estimateRent") === "1") {
                    const district = url.searchParams.get("district")?.trim();
                    const areaParam = url.searchParams.get("area")?.trim();
                    const disposition = url.searchParams.get("disposition")?.trim() || undefined;

                    if (!district || !areaParam) {
                        return Response.json({ error: "Missing required params: district, area" }, { status: 400 });
                    }

                    const area = Number(areaParam);

                    if (!Number.isFinite(area) || area <= 0) {
                        return Response.json({ error: "Invalid area parameter" }, { status: 400 });
                    }

                    const estimate = reasDatabase.estimateMonthlyRent({ district, disposition, area });
                    return Response.json({ estimate });
                }

                const result = getAllPropertiesWithHistory();
                return Response.json(result);
            }),

            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                const name = body.name as string | undefined;
                const district = body.district as string | undefined;
                const constructionType = body.constructionType as string | undefined;
                const alertYieldFloorValue = body.alertYieldFloor;
                const parsedAlertYieldFloor =
                    alertYieldFloorValue == null || alertYieldFloorValue === ""
                        ? undefined
                        : Number(alertYieldFloorValue);

                if (!name || !district || !constructionType) {
                    return Response.json(
                        { error: "Missing required fields: name, district, constructionType" },
                        { status: 400 }
                    );
                }

                const id = reasDatabase.saveProperty({
                    name,
                    district,
                    constructionType,
                    disposition: body.disposition as string | undefined,
                    targetPrice: Number(body.targetPrice) || 0,
                    targetArea: Number(body.targetArea) || 0,
                    monthlyRent: Number(body.monthlyRent) || 0,
                    monthlyCosts: Number(body.monthlyCosts) || 0,
                    periods: body.periods as string | undefined,
                    providers: body.providers as string | undefined,
                    listingUrl: body.listingUrl as string | undefined,
                    mortgageRate: body.mortgageRate ? Number(body.mortgageRate) : undefined,
                    mortgageTerm: body.mortgageTerm ? Number(body.mortgageTerm) : undefined,
                    downPayment: body.downPayment ? Number(body.downPayment) : undefined,
                    loanAmount: body.loanAmount ? Number(body.loanAmount) : undefined,
                    alertYieldFloor: parsedAlertYieldFloor,
                    alertGradeChange: body.alertGradeChange === true,
                    notes: body.notes as string | undefined,
                });

                return Response.json({ id }, { status: 201 });
            }),

            PATCH: apiHandler(async (request) => {
                const url = new URL(request.url);
                const idParam = url.searchParams.get("id");

                if (!idParam) {
                    return Response.json({ error: "Missing required parameter: id" }, { status: 400 });
                }

                const id = Number(idParam);

                if (Number.isNaN(id)) {
                    return Response.json({ error: "Invalid id parameter" }, { status: 400 });
                }

                const property = reasDatabase.getProperty(id);

                if (!property) {
                    return Response.json({ error: "Property not found" }, { status: 404 });
                }

                const contentType = request.headers.get("content-type") ?? "";

                if (contentType.includes("application/json")) {
                    const body = await jsonBody(request);

                    if (body instanceof Response) {
                        return body;
                    }

                    if (body.action === "update-settings") {
                        const alertYieldFloorValue = body.alertYieldFloor;
                        const parsedAlertYieldFloor =
                            alertYieldFloorValue == null || alertYieldFloorValue === ""
                                ? undefined
                                : Number(alertYieldFloorValue);

                        if (
                            alertYieldFloorValue != null &&
                            alertYieldFloorValue !== "" &&
                            !Number.isFinite(parsedAlertYieldFloor)
                        ) {
                            return Response.json({ error: "Invalid alertYieldFloor value" }, { status: 400 });
                        }

                        reasDatabase.updatePropertySettings(id, {
                            alertYieldFloor: parsedAlertYieldFloor,
                            alertGradeChange: body.alertGradeChange === true,
                        });

                        const updatedProperty = reasDatabase.getProperty(id);
                        return Response.json({ property: updatedProperty });
                    }
                }

                const updated = await refreshPropertyAnalysis(id);
                return Response.json({ property: updated });
            }),

            DELETE: apiHandler(async (request) => {
                const url = new URL(request.url);
                const idParam = url.searchParams.get("id");

                if (!idParam) {
                    return Response.json({ error: "Missing required parameter: id" }, { status: 400 });
                }

                const id = Number(idParam);

                if (Number.isNaN(id)) {
                    return Response.json({ error: "Invalid id parameter" }, { status: 400 });
                }

                reasDatabase.deleteProperty(id);
                return Response.json({ deleted: true });
            }),
        },
    },
});
