// HAR 1.2 Spec types (minimal - only what we need)
export interface HarFile {
	log: {
		version: string;
		creator: { name: string; version: string };
		browser?: { name: string; version: string };
		pages?: HarPage[];
		entries: HarEntry[];
	};
}

export interface HarPage {
	startedDateTime: string;
	id: string;
	title: string;
	pageTimings: { onContentLoad?: number; onLoad?: number };
}

export interface HarEntry {
	pageref?: string;
	startedDateTime: string;
	time: number;
	request: HarRequest;
	response: HarResponse;
	cache: Record<string, unknown>;
	timings: HarTimings;
	serverIPAddress?: string;
	connection?: string;
}

export interface HarRequest {
	method: string;
	url: string;
	httpVersion: string;
	headers: HarHeader[];
	queryString: HarQueryParam[];
	cookies: HarCookie[];
	headersSize: number;
	bodySize: number;
	postData?: { mimeType: string; text?: string; params?: HarParam[] };
}

export interface HarResponse {
	status: number;
	statusText: string;
	httpVersion: string;
	headers: HarHeader[];
	cookies: HarCookie[];
	content: HarContent;
	redirectURL: string;
	headersSize: number;
	bodySize: number;
}

export interface HarContent {
	size: number;
	compression?: number;
	mimeType: string;
	text?: string;
	encoding?: string; // "base64" for binary
}

export interface HarHeader {
	name: string;
	value: string;
}
export interface HarQueryParam {
	name: string;
	value: string;
}
export interface HarCookie {
	name: string;
	value: string;
	path?: string;
	domain?: string;
	expires?: string;
	httpOnly?: boolean;
	secure?: boolean;
}
export interface HarParam {
	name: string;
	value?: string;
	fileName?: string;
	contentType?: string;
}
export interface HarTimings {
	blocked?: number;
	dns?: number;
	connect?: number;
	send: number;
	wait: number;
	receive: number;
	ssl?: number;
}

// Session types
export interface IndexedEntry {
	index: number;
	method: string;
	url: string;
	domain: string;
	path: string;
	status: number;
	statusText: string;
	mimeType: string;
	requestSize: number;
	responseSize: number;
	timeMs: number;
	startedDateTime: string;
	requestBodySize: number;
	responseBodySize: number;
	requestBodyMimeType: string;
	hasRequestBody: boolean;
	hasResponseBody: boolean;
	isError: boolean;
	isRedirect: boolean;
	redirectURL: string;
}

export interface SessionStats {
	entryCount: number;
	domains: Record<string, number>;
	statusDistribution: Record<string, number>;
	totalSizeBytes: number;
	totalTimeMs: number;
	errorCount: number;
	mimeTypeDistribution: Record<string, number>;
	startTime: string;
	endTime: string;
}

export interface HarSession {
	version: 1;
	sourceFile: string;
	sourceHash: string;
	createdAt: number;
	lastAccessedAt: number;
	stats: SessionStats;
	entries: IndexedEntry[];
	domains: Record<string, number[]>;
}

// Reference types
export interface RefEntry {
	preview: string; // First 80 chars
	size: number; // Full content char count
	shown: boolean; // Has full content been shown at least once?
}

export interface RefStore {
	refs: Record<string, RefEntry>;
}

// Filter types
export interface EntryFilter {
	domain?: string;
	url?: string;
	status?: string; // "200", "4xx", "5xx", etc.
	method?: string;
	type?: string; // mime type glob
	minTime?: number;
	minSize?: number;
	limit?: number;
}

// Global output options (from CLI flags)
export type OutputFormat = "md" | "json" | "toon";

export interface OutputOptions {
	format: OutputFormat; // --format: md (default), json, toon
	full?: boolean; // --full: bypass ref system, show everything
	includeAll?: boolean; // --include-all: show static asset bodies
	session?: string; // --session: specific session hash
	verbose?: boolean; // -v: verbose logging
}

// MIME types whose bodies are shown by default
const INTERESTING_MIME_TYPES = [
	"application/json",
	"text/json",
	"text/html",
	"text/xml",
	"application/xml",
	"text/plain",
	"application/x-www-form-urlencoded",
	"multipart/form-data",
];

// Returns true if body content should be shown for this MIME type
export function isInterestingMimeType(mimeType: string): boolean {
	const normalized = mimeType.split(";")[0].trim().toLowerCase();
	return INTERESTING_MIME_TYPES.some((t) => normalized === t || normalized.startsWith("application/json"));
}
