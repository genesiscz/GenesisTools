import { fetchAndAnalyze } from "@app/Internal/commands/reas/lib/analysis-service";
import { buildConfig, resolveDistrict } from "@app/Internal/commands/reas/lib/config-builder";
import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, jsonBody } from "../../server/api-utils";

export const Route = createFileRoute("/api/properties")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const properties = reasDatabase.getProperties();
                return Response.json({ properties });
            }),

            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                const name = body.name as string | undefined;
                const district = body.district as string | undefined;
                const constructionType = body.constructionType as string | undefined;

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

                const district = resolveDistrict(property.district);
                const { filters, target } = buildConfig({
                    district,
                    constructionType: property.construction_type,
                    disposition: property.disposition ?? undefined,
                    periodsStr: property.periods ?? undefined,
                    price: property.target_price,
                    area: property.target_area,
                    rent: property.monthly_rent,
                    monthlyCosts: property.monthly_costs,
                    providers: property.providers ?? undefined,
                });

                const analysis = await fetchAndAnalyze(filters, target, true);
                reasDatabase.updatePropertyAnalysis(id, analysis);

                const updated = reasDatabase.getProperty(id);
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
