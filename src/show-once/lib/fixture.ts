import { logger } from "@genesiscz/utils/logger";

export function startReportFixture() {
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === "/report.csv") {
                const values = ["customer", "month", "report"].map((key) => url.searchParams.get(key) ?? "");
                if (values.some((value) => !/^[a-zA-Z0-9_-]{1,80}$/.test(value))) {
                    return new Response("Unsupported report input", { status: 400 });
                }
                return new Response(`customer,month,report,total\n${values.join(",")},42\n`, {
                    headers: {
                        "Content-Type": "text/csv",
                        "Content-Disposition": `attachment; filename="${values.join("-")}.csv"`,
                    },
                });
            }
            if (url.pathname !== "/") {
                return new Response("Not found", { status: 404 });
            }
            return new Response(Bun.file(new URL("../fixtures/report.html", import.meta.url)), {
                headers: { "Content-Type": "text/html" },
            });
        },
    });
    logger.info({ port: server.port }, "Show Once local report fixture started");
    return { url: `http://127.0.0.1:${server.port}/`, close: () => server.stop(true) };
}
