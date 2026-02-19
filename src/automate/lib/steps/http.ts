// src/automate/lib/steps/http.ts

import { registerStepHandler, registerStepCatalog } from "../registry";
import type { StepContext } from "../registry";
import type { HttpStepParams, PresetStep, StepResult } from "../types";
import { loadCredential, resolveCredentialHeaders } from "../credentials";
import { makeResult } from "./helpers";

async function httpHandler(step: PresetStep, ctx: StepContext): Promise<StepResult> {
  const start = performance.now();
  const params = step.params as unknown as HttpStepParams;

  if (!params?.url) {
    return makeResult("error", null, start, `http step "${step.id}" requires params.url`);
  }

  const method = step.action.split(".")[1]?.toUpperCase() ?? "GET";
  const url = new URL(ctx.interpolate(params.url));

  // Query params
  if (params.query) {
    for (const [key, value] of Object.entries(params.query)) {
      url.searchParams.set(key, ctx.interpolate(value));
    }
  }

  // Headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Credential headers
  if (params.credential) {
    const credName = ctx.interpolate(params.credential);
    // Try loading from disk first, then check preset-level credentials
    const stored = await loadCredential(credName);
    if (stored) {
      Object.assign(headers, resolveCredentialHeaders(stored, ctx.interpolate));
    } else {
      ctx.log("warn", `Credential "${credName}" not found`);
    }
  }

  // Custom headers (override defaults)
  if (params.headers) {
    for (const [key, value] of Object.entries(params.headers)) {
      headers[key] = ctx.interpolate(value);
    }
  }

  // Body
  let body: string | undefined;
  if (params.body && method !== "GET" && method !== "HEAD") {
    if (typeof params.body === "string") {
      body = ctx.interpolate(params.body);
    } else {
      body = JSON.stringify(params.body, (_key, value) => {
        if (typeof value === "string" && value.includes("{{")) {
          return ctx.interpolate(value);
        }
        return value;
      });
    }
  }

  const timeout = params.timeout ?? 30_000;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);

    // Parse response body
    const contentType = response.headers.get("content-type") ?? "";
    let responseBody: unknown;
    if (contentType.includes("application/json")) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    // Validate status
    const statusOk = params.validateStatus
      ? Boolean(ctx.evaluate(params.validateStatus.replace(/\bstatus\b/g, String(response.status))))
      : response.ok;

    const output = {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody,
    };

    if (!statusOk) {
      return makeResult("error", output, start, `HTTP ${response.status} ${response.statusText}`);
    }

    return makeResult("success", output, start);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return makeResult("error", null, start, message);
  }
}

registerStepHandler("http", httpHandler);
registerStepCatalog({
  prefix: "http",
  description: "HTTP requests",
  actions: [
    { action: "http.get", description: "GET request", params: [
      { name: "url", required: true, description: "Target URL" },
      { name: "headers", description: "Custom headers" },
      { name: "query", description: "Query parameters" },
      { name: "credential", description: "Stored credential name" },
      { name: "timeout", description: "Timeout in ms (default: 30000)" },
      { name: "validateStatus", description: "Expression to validate status code" },
    ]},
    { action: "http.post", description: "POST request", params: [
      { name: "url", required: true, description: "Target URL" },
      { name: "body", description: "Request body (JSON or string)" },
      { name: "headers", description: "Custom headers" },
      { name: "credential", description: "Stored credential name" },
    ]},
    { action: "http.put", description: "PUT request", params: [
      { name: "url", required: true, description: "Target URL" },
      { name: "body", description: "Request body" },
    ]},
    { action: "http.patch", description: "PATCH request", params: [
      { name: "url", required: true, description: "Target URL" },
      { name: "body", description: "Request body" },
    ]},
    { action: "http.delete", description: "DELETE request", params: [
      { name: "url", required: true, description: "Target URL" },
    ]},
  ],
});
