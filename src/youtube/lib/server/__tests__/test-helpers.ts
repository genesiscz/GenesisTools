/** Base URL for a test server's /api/v1 namespace — extracts the
 *  `http://localhost:${port}/api/v1${path}` template repeated across
 *  the server route tests. */
export function apiUrl(port: number, path = ""): string {
    return `http://localhost:${port}/api/v1${path}`;
}
