import { createServer } from "node:net";

export async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();

            if (typeof address === "object" && address) {
                const { port } = address;
                server.close(() => resolve(port));
            } else {
                server.close(() => reject(new Error("no address from free-port probe")));
            }
        });
    });
}
