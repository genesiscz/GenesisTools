import type { Command } from "commander";
import { SessionManager } from "@app/har-analyzer/core/session-manager";
import { loadHarFile } from "@app/har-analyzer/core/parser";
import { truncatePath, printFormatted } from "@app/har-analyzer/core/formatter";
import type { HarEntry, HarHeader, OutputOptions } from "@app/har-analyzer/types";

type Severity = "HIGH" | "MEDIUM" | "LOW";

interface SecurityFinding {
	severity: Severity;
	category: string;
	entryIndex: number;
	method: string;
	path: string;
	detail: string;
}

const SEVERITY_SYMBOLS: Record<Severity, string> = {
	HIGH: "[!!!]",
	MEDIUM: "[!!]",
	LOW: "[!]",
};

const API_KEY_PATTERNS = ["api_key", "apikey", "x-api-key", "key", "secret", "token"];
const SENSITIVE_PARAM_PATTERNS = ["password", "passwd", "secret", "token", "auth"];

function findHeader(headers: HarHeader[], name: string): HarHeader | undefined {
	const lower = name.toLowerCase();
	return headers.find((h) => h.name.toLowerCase() === lower);
}

function decodeBase64Url(str: string): string {
	const padded = str.replace(/-/g, "+").replace(/_/g, "/");
	return atob(padded);
}

function tryDecodeJwtPart(part: string): Record<string, unknown> | null {
	try {
		return JSON.parse(decodeBase64Url(part)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function scanJwt(entry: HarEntry, index: number, findings: SecurityFinding[]): void {
	const authHeader = findHeader(entry.request.headers, "Authorization");
	if (!authHeader) return;

	const match = authHeader.value.match(/^Bearer\s+(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)/);
	if (!match) return;

	const token = match[1];
	const parts = token.split(".");

	const header = tryDecodeJwtPart(parts[0]);
	const payload = parts[1] ? tryDecodeJwtPart(parts[1]) : null;

	let detail = "JWT detected in Authorization header";
	const extras: string[] = [];

	if (header?.alg) {
		extras.push(`alg=${String(header.alg)}`);
	}

	if (payload?.exp) {
		const expDate = new Date(Number(payload.exp) * 1000);
		const isExpired = expDate.getTime() < Date.now();
		extras.push(`exp=${expDate.toISOString()}${isExpired ? " (EXPIRED)" : ""}`);
	}

	if (extras.length > 0) {
		detail += ` [${extras.join(", ")}]`;
	}

	const { hostname, pathname } = parseUrl(entry.request.url);
	findings.push({
		severity: "MEDIUM",
		category: "JWT Exposure",
		entryIndex: index,
		method: entry.request.method,
		path: truncatePath(pathname + (hostname ? ` (${hostname})` : ""), 60),
		detail,
	});
}

function scanApiKeys(entry: HarEntry, index: number, findings: SecurityFinding[]): void {
	const { hostname, pathname, searchParams } = parseUrl(entry.request.url);

	for (const [paramName, paramValue] of searchParams) {
		const lowerName = paramName.toLowerCase();
		const matched = API_KEY_PATTERNS.some((pattern) => lowerName === pattern || lowerName.includes(pattern));

		if (matched && paramValue.length > 0) {
			findings.push({
				severity: "HIGH",
				category: "API Key in Query String",
				entryIndex: index,
				method: entry.request.method,
				path: truncatePath(pathname + (hostname ? ` (${hostname})` : ""), 60),
				detail: `Parameter "${paramName}" contains potential API key (${paramValue.length} chars)`,
			});
		}
	}

	// Also check request headers for API keys
	for (const header of entry.request.headers) {
		const lowerName = header.name.toLowerCase();
		// Skip authorization header (handled by scanJwt)
		if (lowerName === "authorization") continue;
		const matched = API_KEY_PATTERNS.some((pattern) => lowerName === pattern || lowerName.includes(pattern));

		if (matched && header.value.length > 0) {
			findings.push({
				severity: "HIGH",
				category: "API Key in Header",
				entryIndex: index,
				method: entry.request.method,
				path: truncatePath(pathname + (hostname ? ` (${hostname})` : ""), 60),
				detail: `Header "${header.name}" contains potential API key (${header.value.length} chars)`,
			});
		}
	}
}

function scanCookies(entry: HarEntry, index: number, findings: SecurityFinding[]): void {
	const setCookieHeaders = entry.response.headers.filter(
		(h) => h.name.toLowerCase() === "set-cookie",
	);

	for (const header of setCookieHeaders) {
		const value = header.value.toLowerCase();
		const cookieName = header.value.split("=")[0]?.trim() ?? "unknown";
		const issues: string[] = [];

		if (!value.includes("httponly")) {
			issues.push("missing HttpOnly");
		}
		if (!value.includes("secure")) {
			issues.push("missing Secure");
		}

		if (issues.length > 0) {
			const { hostname, pathname } = parseUrl(entry.request.url);
			findings.push({
				severity: "LOW",
				category: "Insecure Cookie",
				entryIndex: index,
				method: entry.request.method,
				path: truncatePath(pathname + (hostname ? ` (${hostname})` : ""), 60),
				detail: `Cookie "${cookieName}": ${issues.join(", ")}`,
			});
		}
	}
}

function scanSensitiveParams(entry: HarEntry, index: number, findings: SecurityFinding[]): void {
	const { hostname, pathname, searchParams } = parseUrl(entry.request.url);

	for (const [paramName] of searchParams) {
		const lowerName = paramName.toLowerCase();
		const matched = SENSITIVE_PARAM_PATTERNS.some(
			(pattern) => lowerName === pattern || lowerName.includes(pattern),
		);

		if (matched) {
			findings.push({
				severity: "HIGH",
				category: "Sensitive Data in URL",
				entryIndex: index,
				method: entry.request.method,
				path: truncatePath(pathname + (hostname ? ` (${hostname})` : ""), 60),
				detail: `Sensitive parameter "${paramName}" found in query string`,
			});
		}
	}
}

function parseUrl(url: string): { hostname: string; pathname: string; searchParams: URLSearchParams } {
	try {
		const parsed = new URL(url);
		return { hostname: parsed.hostname, pathname: parsed.pathname, searchParams: parsed.searchParams };
	} catch {
		return { hostname: "", pathname: url, searchParams: new URLSearchParams() };
	}
}

export function registerSecurityCommand(program: Command): void {
	program
		.command("security")
		.description("Scan for sensitive data exposure")
		.action(async () => {
			const parentOpts = program.opts<OutputOptions>();
			const sm = new SessionManager();
			const session = await sm.requireSession(parentOpts.session);

			const har = await loadHarFile(session.sourceFile);
			const findings: SecurityFinding[] = [];

			for (let i = 0; i < har.log.entries.length; i++) {
				const entry = har.log.entries[i];
				scanJwt(entry, i, findings);
				scanApiKeys(entry, i, findings);
				scanCookies(entry, i, findings);
				scanSensitiveParams(entry, i, findings);
			}

			if (findings.length === 0) {
				console.log("No security issues detected.");
				return;
			}

			// Group by severity
			const bySeverity = new Map<Severity, SecurityFinding[]>();
			for (const finding of findings) {
				const group = bySeverity.get(finding.severity);
				if (group) {
					group.push(finding);
				} else {
					bySeverity.set(finding.severity, [finding]);
				}
			}

			const lines: string[] = [];
			lines.push(`Security Scan: ${findings.length} finding(s)`);
			lines.push("");

			const severityOrder: Severity[] = ["HIGH", "MEDIUM", "LOW"];

			for (const severity of severityOrder) {
				const group = bySeverity.get(severity);
				if (!group) continue;

				lines.push(`── ${SEVERITY_SYMBOLS[severity]} ${severity} (${group.length}) ──`);
				lines.push("");

				for (const finding of group) {
					lines.push(`  e${finding.entryIndex}  ${finding.method}  ${finding.path}`);
					lines.push(`       ${finding.category}: ${finding.detail}`);
				}

				lines.push("");
			}

			await printFormatted(lines.join("\n"), parentOpts.format);
		});
}
