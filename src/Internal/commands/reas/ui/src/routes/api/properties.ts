import { createFileRoute } from "@tanstack/react-router";
import type { SavePropertyInput } from "@app/Internal/commands/reas/lib/store";
import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
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

                const input = body as unknown as SavePropertyInput;

                if (!input.name || !input.district || !input.constructionType) {
                    return Response.json(
                        { error: "Missing required fields: name, district, constructionType" },
                        { status: 400 },
                    );
                }

                const id = reasDatabase.saveProperty({
                    name: input.name,
                    district: input.district,
                    constructionType: input.constructionType,
                    disposition: input.disposition,
                    targetPrice: Number(input.targetPrice) || 0,
                    targetArea: Number(input.targetArea) || 0,
                    monthlyRent: Number(input.monthlyRent) || 0,
                    monthlyCosts: Number(input.monthlyCosts) || 0,
                    periods: input.periods,
                    providers: input.providers,
                    notes: input.notes,
                });

                return Response.json({ id }, { status: 201 });
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
