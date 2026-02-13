export type QueryParamValue = string | string[] | undefined;
export type QueryParams = Record<string, QueryParamValue>;

interface BuildUrlOptions {
    base: string;
    segments?: string[];
    queryParams?: QueryParams;
    keepTrailingSlash?: boolean;
}

export function appendQueryParamsToSearchParams(
    params: QueryParams,
    searchParams: URLSearchParams = new URLSearchParams()
): URLSearchParams {
    Object.entries(params).forEach(([key, value]) => {
        if (value === undefined) {
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((v) => searchParams.append(key, v));
        } else {
            searchParams.set(key, value);
        }
    });
    return searchParams;
}

export function buildUrl({ base, segments = [], queryParams, keepTrailingSlash = true }: BuildUrlOptions): string {
    const [basePath, existingQuery] = base.split("?");
    const hasBase = basePath.trim().length > 0;
    const normalizedSegments = segments.map((segment) => {
        if (hasBase && (segment.startsWith("http://") || segment.startsWith("https://"))) {
            try {
                return new URL(segment).pathname;
            } catch {
                return segment;
            }
        }
        return segment;
    });
    const lastSegment = segments.length > 0 ? segments[segments.length - 1] : basePath;
    const hadTrailingSlash = lastSegment.endsWith("/");
    let normalizedPath = [basePath, ...normalizedSegments]
        .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
        .filter(Boolean)
        .join("/");
    if (keepTrailingSlash && hadTrailingSlash && normalizedPath.length > 0) {
        normalizedPath += "/";
    }
    const searchParams = new URLSearchParams(existingQuery ?? "");
    if (queryParams && Object.keys(queryParams).length > 0) {
        appendQueryParamsToSearchParams(queryParams, searchParams);
    }
    const queryString = searchParams.toString();
    return queryString ? `${normalizedPath}?${queryString}` : normalizedPath;
}

export function withQueryParams(urlString: string, params: QueryParams): string {
    const url = new URL(urlString);
    appendQueryParamsToSearchParams(params, url.searchParams);
    return url.toString();
}
