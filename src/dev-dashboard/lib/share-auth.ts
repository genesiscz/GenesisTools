const PUBLIC_SHARE_PATH_RE = /^\/share\/[^/]+\/?$/;

export function isPublicShareRequest(method: string, pathname: string): boolean {
    return (method === "GET" || method === "HEAD") && PUBLIC_SHARE_PATH_RE.test(pathname);
}
