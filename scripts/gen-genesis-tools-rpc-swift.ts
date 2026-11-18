#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AREAS } from "@genesiscz/utils/genesis-tools/areas";
import { genesisToolsApi, requestPresentApi, serviceEvents } from "@genesiscz/utils/genesis-tools/service/api";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { z } from "zod";

interface WireSchema {
    type?: string | string[];
    properties?: Record<string, WireSchema>;
    required?: string[];
    additionalProperties?: boolean | WireSchema;
    items?: WireSchema;
    anyOf?: WireSchema[];
    oneOf?: WireSchema[];
    enum?: unknown[];
    const?: unknown;
    default?: unknown;
    format?: string;
    minItems?: number;
    minimum?: number;
    $ref?: string;
    allOf?: WireSchema[];
    not?: WireSchema;
    prefixItems?: WireSchema[];
}
const ROOT = resolve(import.meta.dirname, "..");
export const SWIFT_PATH = resolve(ROOT, "src/macos/GenesisKit/Sources/GenesisKitBase/Generated/GenesisToolsRPC.swift");
export const WIRE_PATH = resolve(ROOT, "src/utils/genesis-tools/service/__fixtures__/wire.json");
const title = (text: string): string =>
    text
        .split(/[^a-zA-Z0-9]+/)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join("");
const quoted = (text: string): string => SafeJSON.stringify(text);
const optional = (type: string): string => (type.endsWith("?") ? type : `${type}?`);
function schemaOf(schema: z.ZodType): WireSchema {
    return z.toJSONSchema(schema, { io: "input" }) as WireSchema;
}

export function renderSwiftSchema(schema: WireSchema, name: string, declarations: string[], owner: string): string {
    const fail = (): never => {
        throw new Error(`${owner}: cannot map schema ${SafeJSON.stringify(schema)}`);
    };
    if (schema.$ref || schema.allOf || schema.not || schema.prefixItems) {
        return fail();
    }
    const variants = schema.anyOf ?? schema.oneOf;
    if (variants) {
        const nonNull = variants.filter((s) => s.type !== "null");
        if (nonNull.length === 1 && variants.length !== nonNull.length) {
            return optional(renderSwiftSchema(nonNull[0], name, declarations, owner));
        }
        const types = variants.map((variant, i) =>
            renderSwiftSchema(variant, `${name}Option${i}`, declarations, owner)
        );
        declarations.push(
            `public enum ${name}: Codable, Sendable {\n${types.map((type, i) => `    case option${i}(${type})`).join("\n")}\n    public init(from decoder: Decoder) throws {\n${types.map((type, i) => `        if let value = try? ${type}(from: decoder) { self = .option${i}(value); return }`).join("\n")}\n        throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No ${name} variant matched"))\n    }\n    public func encode(to encoder: Encoder) throws {\n        switch self {\n${types.map((_, i) => `        case let .option${i}(value): try value.encode(to: encoder)`).join("\n")}\n        }\n    }\n}`
        );
        return name;
    }
    if (Array.isArray(schema.type)) {
        return renderSwiftSchema(
            { anyOf: schema.type.map((type) => ({ ...schema, type })) },
            name,
            declarations,
            owner
        );
    }
    if (typeof schema.const === "boolean") {
        const literal = String(schema.const);
        declarations.push(
            `public enum ${name}: Codable, Sendable {\n    case value0\n    public init(from decoder: Decoder) throws {\n        let value = try decoder.singleValueContainer().decode(Bool.self)\n        guard value == ${literal} else { throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Expected ${literal}")) }\n        self = .value0\n    }\n    public func encode(to encoder: Encoder) throws { var box = encoder.singleValueContainer(); try box.encode(${literal}) }\n}`
        );
        return name;
    }
    if (typeof schema.const === "number") {
        declarations.push(`public enum ${name}: Double, Codable, Sendable { case value0 = ${schema.const} }`);
        return name;
    }
    const values = schema.enum ?? (typeof schema.const === "string" ? [schema.const] : undefined);
    if (values) {
        if (!values.every((value) => typeof value === "string")) {
            return fail();
        }
        declarations.push(
            `public enum ${name}: String, Codable, Sendable {\n${values.map((value, i) => `    case value${i} = ${quoted(String(value))}`).join("\n")}\n}`
        );
        return name;
    }
    switch (schema.type) {
        case "object": {
            if (!schema.properties && typeof schema.additionalProperties === "object") {
                return `[String: ${renderSwiftSchema(schema.additionalProperties, `${name}Value`, declarations, owner)}]`;
            }
            if (!schema.properties && schema.additionalProperties === true) {
                return "[String: GenesisToolsJSON]";
            }
            const fields = Object.entries(schema.properties ?? {}).map(([key, value]) => ({
                key,
                required: (schema.required ?? []).includes(key),
                type: (schema.required ?? []).includes(key)
                    ? renderSwiftSchema(value, `${name}${title(key)}`, declarations, owner)
                    : optional(renderSwiftSchema(value, `${name}${title(key)}`, declarations, owner)),
            }));
            const coding =
                fields.length === 0
                    ? ""
                    : `\n    private enum CodingKeys: String, CodingKey { ${fields.map((f) => `case \`${f.key}\``).join("; ")} }\n    public init(from decoder: Decoder) throws {\n        let box = try decoder.container(keyedBy: CodingKeys.self)\n${fields.map((f) => `        self.\`${f.key}\` = try box.${f.required ? `decode(${f.type}.self` : `decodeIfPresent(${f.type.slice(0, -1)}.self`}, forKey: .\`${f.key}\`)`).join("\n")}\n    }\n    public func encode(to encoder: Encoder) throws {\n        var box = encoder.container(keyedBy: CodingKeys.self)\n${fields.map((f) => `        try box.${f.required ? "encode" : "encodeIfPresent"}(\`${f.key}\`, forKey: .\`${f.key}\`)`).join("\n")}\n    }`;
            declarations.push(
                `public struct ${name}: Codable, Sendable {\n${fields.map((f) => `    public var \`${f.key}\`: ${f.type}`).join("\n")}\n    public init(${fields.map((f) => `\`${f.key}\`: ${f.type}${f.type.endsWith("?") ? " = nil" : ""}`).join(", ")}) {\n${fields.map((f) => `        self.\`${f.key}\` = \`${f.key}\``).join("\n")}\n    }${coding}\n}`
            );
            return name;
        }
        case "array":
            return `[${renderSwiftSchema(schema.items ?? {}, `${name}Item`, declarations, owner)}]`;
        case "string":
            return "String";
        case "integer":
            return "Int";
        case "number":
            return "Double";
        case "boolean":
            return "Bool";
        case "null":
            return "GenesisToolsNull";
        case undefined:
            return "GenesisToolsJSON";
        default:
            return fail();
    }
}
/** A value of `schema`. Every union (and every type list) takes its alternative `variant % count`, so variant 1 is
 * the second branch of an action reply and the null of a nullable field, and every variant below `unionWidth` is a
 * different wire shape. */
function sample(schema: WireSchema, variant = 0): unknown {
    if (schema.default !== undefined) {
        return schema.default;
    }
    if (schema.const !== undefined) {
        return schema.const;
    }
    if (schema.enum) {
        return schema.enum[0];
    }
    const options = schema.anyOf ?? schema.oneOf;
    if (options) {
        return sample(options[variant % options.length], variant);
    }
    if (Array.isArray(schema.type)) {
        return sample({ ...schema, type: schema.type[variant % schema.type.length] }, variant);
    }
    switch (schema.type) {
        case "object":
            return Object.fromEntries(
                Object.entries(schema.properties ?? {}).map(([key, value]) => [key, sample(value, variant)])
            );
        case "array":
            return Array.from({ length: Math.max(schema.minItems ?? 0, variant > 0 ? 1 : 0) }, () =>
                sample(schema.items ?? {}, variant)
            );
        case "string":
            return schema.format === "date-time" ? "2026-11-17T12:00:00.000Z" : "fixture";
        case "integer":
        case "number":
            return schema.minimum ?? 1;
        case "boolean":
            return true;
        default:
            return null;
    }
}

/** The most alternatives any one union in `schema` has: the number of `sample` variants worth writing. */
function unionWidth(schema: WireSchema): number {
    const nested = [
        ...(schema.anyOf ?? schema.oneOf ?? []),
        ...Object.values(schema.properties ?? {}),
        ...(schema.items ? [schema.items] : []),
        ...(typeof schema.additionalProperties === "object" ? [schema.additionalProperties] : []),
    ];
    const own = Math.max(
        (schema.anyOf ?? schema.oneOf ?? []).length,
        Array.isArray(schema.type) ? schema.type.length : 1
    );
    return Math.max(own, ...nested.map(unionWidth));
}

const JSON_TYPE = `public indirect enum GenesisToolsJSON: Codable, Sendable {
    case null, bool(Bool), number(Double), string(String), array([GenesisToolsJSON]), object([String: GenesisToolsJSON])
    public init(from decoder: Decoder) throws {
        let box = try decoder.singleValueContainer()
        if box.decodeNil() { self = .null }
        else if let value = try? box.decode(Bool.self) { self = .bool(value) }
        else if let value = try? box.decode(Double.self) { self = .number(value) }
        else if let value = try? box.decode(String.self) { self = .string(value) }
        else if let value = try? box.decode([GenesisToolsJSON].self) { self = .array(value) }
        else { self = .object(try box.decode([String: GenesisToolsJSON].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var box = encoder.singleValueContainer()
        switch self {
        case .null: try box.encodeNil()
        case let .bool(value): try box.encode(value)
        case let .number(value): try box.encode(value)
        case let .string(value): try box.encode(value)
        case let .array(value): try box.encode(value)
        case let .object(value): try box.encode(value)
        }
    }
}

/// A JSON null and nothing else: the null arm of a union, so it never takes a value that belongs to another arm.
public struct GenesisToolsNull: Codable, Sendable, Equatable {
    public init() {}
    public init(from decoder: Decoder) throws {
        guard try decoder.singleValueContainer().decodeNil() else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Expected null"))
        }
    }
    public func encode(to encoder: Encoder) throws { var box = encoder.singleValueContainer(); try box.encodeNil() }
}`;

export function renderGenesisToolsRPC(): { swift: string; fixtures: string } {
    const declarations: string[] = [];
    const methods = [...genesisToolsApi.methods, ...requestPresentApi.methods];
    const models = new Map<string, { params: string; result: string }>();
    const fixtures = methods.flatMap((method) => {
        let paramsSchema: WireSchema;
        let resultSchema: WireSchema;
        try {
            paramsSchema = schemaOf(method.params);
            resultSchema = schemaOf(method.result);
        } catch (error) {
            throw new Error(`${method.name}: schema cannot be generated`, { cause: error });
        }
        models.set(method.name, {
            params: renderSwiftSchema(paramsSchema, `${title(method.name)}Params`, declarations, method.name),
            result: renderSwiftSchema(resultSchema, `${title(method.name)}Result`, declarations, method.name),
        });
        // One row per variant, so every union arm and every null of a nullable field reaches both decoders.
        const rows = new Map<string, { method: string; params: unknown; result: unknown }>();
        const width = Math.max(unionWidth(paramsSchema), unionWidth(resultSchema));
        for (let variant = 0; variant < width; variant++) {
            const row = {
                method: method.name,
                params: method.params.parse(sample(paramsSchema, variant)),
                result: method.result.parse(sample(resultSchema, variant)),
            };
            rows.set(SafeJSON.stringify(row), row);
        }
        return [...rows.values()];
    });
    const areas = Object.entries(AREAS)
        .map(
            ([area, definition]) =>
                `    public lazy var ${area} = ${title(area)}(owner: self)\n    @MainActor public final class ${title(area)} {\n        unowned let owner: GenesisToolsRPC\n        init(owner: GenesisToolsRPC) { self.owner = owner }\n${Object.entries(
                    definition.actions
                )
                    .map(([action, def]) => {
                        const model = models.get(`${area}.${action}`)!;
                        return `        public func ${action}(_ params: ${model.params}) async throws -> ${model.result} { try await owner.call(${quoted(`${area}.${action}`)}, params, timeout: ${(def.timeoutMs ?? 120_000) / 1000 + 10}) }`;
                    })
                    .join("\n")}\n    }`
        )
        .join("\n");
    const extra = genesisToolsApi.methods
        .filter((method) => !Object.keys(AREAS).some((area) => method.name.startsWith(`${area}.`)))
        .map((method) => {
            const model = models.get(method.name)!;
            return `    public func ${method.name.replace(/\.([a-z])/g, (_, c: string) => c.toUpperCase())}(_ params: ${model.params}) async throws -> ${model.result} { try await call(${quoted(method.name)}, params) }`;
        })
        .join("\n");
    const events = Object.entries(serviceEvents)
        .map(([name, schema]) => {
            const type = renderSwiftSchema(schemaOf(schema), `${title(name)}Event`, declarations, name);
            const field = name.replace(/\.([a-z])/g, (_, c: string) => c.toUpperCase());
            return `        public var ${field}: AsyncThrowingStream<${type}, Error> { owner.stream(${quoted(name)}) }`;
        })
        .join("\n");
    const configAreas = Object.entries(AREAS)
        .map(([area, definition]) => {
            const areaConfig =
                "config" in definition && definition.config
                    ? renderSwiftSchema(
                          schemaOf(definition.config.partial()),
                          `Config${title(area)}Area`,
                          declarations,
                          `${area}.config`
                      )
                    : null;
            const actionKeys = Object.entries(definition.actions).flatMap(([action, def]) => {
                if (!def.config) {
                    return [];
                }
                const type = renderSwiftSchema(
                    schemaOf(def.config.partial()),
                    `Config${title(area)}${title(action)}`,
                    declarations,
                    `${area}.${action}.config`
                );
                return [
                    `            public var ${action}: ConfigWriter<${type}> { ConfigWriter(owner: owner, prefix: ${quoted(`${area}.${action}`)}) }`,
                ];
            });
            return `        public var ${area}: ${title(area)}Config { ${title(area)}Config(owner: owner) }\n        public struct ${title(area)}Config {\n            let owner: GenesisToolsRPC\n${areaConfig ? `            public func set(_ value: ${areaConfig}) async throws { try await ConfigWriter<${areaConfig}>(owner: owner, prefix: ${quoted(area)}).set(value) }\n` : ""}${actionKeys.join("\n")}\n        }`;
        })
        .join("\n");
    const present = models.get("request.present")!;
    const decodes = methods
        .map((method) => {
            const m = models.get(method.name)!;
            return `        case ${quoted(method.name)}: _ = try decoder.decode(${m.params}.self, from: params); _ = try decoder.decode(${m.result}.self, from: result)`;
        })
        .join("\n");
    const swift = `// Generated by scripts/gen-genesis-tools-rpc-swift.ts. Do not edit.\nimport Foundation\n\n${JSON_TYPE}\n\n${declarations.join("\n\n")}\n\n@MainActor\npublic final class GenesisToolsRPC {
    public static let shared = GenesisToolsRPC()
    public var timeoutSeconds: TimeInterval = 130
    /// Once per published connection that the service ends (a restart, a crash); not after \`close()\`.
    public var onDisconnect: (() -> Void)?
    private var peer: JSONRPCSocketClient?
    /// The one connection attempt in flight: every caller that finds no peer awaits it.
    private var connecting: Task<JSONRPCSocketClient, Error>?
    private let path: String
    private var handlers: [String: JSONRPCSocketClient.Handler] = [:]
    private struct Listener {
        let deliver: (Data) -> Void
        let finish: (Error?) -> Void
    }
    private var listeners: [String: [UUID: Listener]] = [:]
    public init(path: String = GenesisToolsHome.path("genesis-tools/service.sock")) { self.path = path }
    public func connect() async throws { _ = try await ready() }
    private func ready() async throws -> JSONRPCSocketClient {
        if let peer { return peer }
        if let connecting { return try await connecting.value }
        let attempt = Task { @MainActor in try await self.open() }
        connecting = attempt
        defer { if connecting == attempt { connecting = nil } }
        return try await attempt.value
    }
    /// Starts the service when its socket is missing, and publishes the connection only after \`hello\` and \`subscribe\`.
    private func open() async throws -> JSONRPCSocketClient {
        if !FileManager.default.fileExists(atPath: path) {
            let bridge = ToolsBridge(binaryPath: ToolsBridge.defaultBinaryPath())
            let started = try await bridge.run(subcommand: "genesis-tools", args: ["serve", "--detach"], timeoutSeconds: 20)
            guard started.exitCode == 0 else { throw ToolsBridgeError.refused(started.stderr) }
        }
        let opened = JSONRPCSocketClient(path: path)
        try opened.connect()
        var announced = Set(handlers.keys)
        for (name, handler) in handlers { opened.answer(name, with: handler) }
        opened.onClose = { [weak self, weak opened] in
            Task { @MainActor in
                guard let self, let opened, self.peer === opened else { return }
                self.peer = nil
                self.finishListeners(JSONRPCSocketClient.Failure.closed)
                self.onDisconnect?()
            }
        }
        opened.onNotification = { [weak self] name, value in
            guard let value, let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else { return }
            Task { @MainActor in self?.listeners[name]?.values.forEach { $0.deliver(data) } }
        }
        do {
            _ = try await opened.call("hello", params: ["methods": Array(announced)])
            _ = try await opened.call("subscribe", params: [:])
            // A handler registered while the handshake ran is answered and announced on this connection too.
            while Set(handlers.keys) != announced {
                announced = Set(handlers.keys)
                for (name, handler) in handlers { opened.answer(name, with: handler) }
                _ = try await opened.call("hello", params: ["methods": Array(announced)])
            }
            try Task.checkCancellation()
        } catch {
            opened.close()
            throw error
        }
        peer = opened
        return opened
    }
    public func close() {
        connecting?.cancel()
        connecting = nil
        peer?.close()
        peer = nil
        finishListeners(nil)
    }
    private func finishListeners(_ error: Error?) {
        let ended = listeners.values.flatMap(\\.values)
        listeners = [:]
        ended.forEach { $0.finish(error) }
    }
    fileprivate func call<P: Encodable, R: Decodable>(_ method: String, _ params: P, timeout: TimeInterval? = nil) async throws -> R {
        let peer = try await ready()
        let encoded = try JSONEncoder().encode(params)
        let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        let result = try await peer.call(method, params: object, timeout: timeout ?? timeoutSeconds)
        let bytes = try JSONSerialization.data(withJSONObject: result ?? NSNull(), options: [.fragmentsAllowed])
        return try JSONDecoder().decode(R.self, from: bytes)
    }
    /// Events named \`name\`. The stream ends with the error when the connection cannot be made or the service ends it.
    fileprivate func stream<E: Decodable>(_ name: String) -> AsyncThrowingStream<E, Error> {
        AsyncThrowingStream { continuation in
            let id = UUID()
            listeners[name, default: [:]][id] = Listener(
                deliver: { data in if let value = try? JSONDecoder().decode(E.self, from: data) { continuation.yield(value) } },
                finish: { error in continuation.finish(throwing: error) }
            )
            continuation.onTermination = { [weak self] _ in Task { @MainActor in self?.listeners[name]?[id] = nil } }
            Task {
                do { try await connect() } catch {
                    listeners[name]?[id] = nil
                    continuation.finish(throwing: error)
                }
            }
        }
    }
${areas}
${extra}
    public lazy var events = Events(owner: self)
    @MainActor public final class Events {
        unowned let owner: GenesisToolsRPC
        init(owner: GenesisToolsRPC) { self.owner = owner }
${events}
    }
    public lazy var config = Config(owner: self)
    @MainActor public final class Config {
        unowned let owner: GenesisToolsRPC
        init(owner: GenesisToolsRPC) { self.owner = owner }
${configAreas}
    }
    public struct ConfigWriter<C: Encodable> {
        let owner: GenesisToolsRPC
        let prefix: String
        public func set(_ value: C) async throws {
            let data = try JSONEncoder().encode(value)
            let fields = try JSONDecoder().decode([String: GenesisToolsJSON].self, from: data)
            for (key, value) in fields { let _: ConfigSetResult = try await owner.call("config.set", ConfigSetParams(path: prefix + "." + key, value: value)) }
        }
    }
    public lazy var serve = Serve(owner: self)
    @MainActor public final class Serve {
        unowned let owner: GenesisToolsRPC
        init(owner: GenesisToolsRPC) { self.owner = owner }
        public func requestPresent(_ handler: @escaping (${present.params}) async throws -> ${present.result}) {
            let wrapped: JSONRPCSocketClient.Handler = { incoming, reply in
                Task { @MainActor in
                    do {
                        let data = try JSONSerialization.data(withJSONObject: incoming.object)
                        let params = try JSONDecoder().decode(${present.params}.self, from: data)
                        let value = try await handler(params)
                        reply(.success(try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))))
                    } catch { reply(.failure(error)) }
                }
            }
            owner.handlers["request.present"] = wrapped
            owner.peer?.answer("request.present", with: wrapped)
            if let peer = owner.peer { Task { _ = try? await peer.call("hello", params: ["methods": Array(owner.handlers.keys)]) } }
        }
    }
    public static func validateFixture(method: String, params: Data, result: Data) throws {
        let decoder = JSONDecoder()
        switch method {
${decodes}
        default: throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Unknown method " + method))
        }
    }
}\n`;
    return { swift, fixtures: `${SafeJSON.stringify(fixtures, null, 2)}\n` };
}

export function writeOrCheckGenesisToolsRPC(): void {
    const rendered = renderGenesisToolsRPC();
    for (const [file, content] of [
        [SWIFT_PATH, rendered.swift],
        [WIRE_PATH, rendered.fixtures],
    ]) {
        if (process.argv.includes("--check")) {
            if (!existsSync(file) || readFileSync(file, "utf8") !== content) {
                throw new Error(`${file} is stale; run bun scripts/gen-genesis-tools-rpc-swift.ts`);
            }
            out.println(`gen-genesis-tools-rpc-swift: matches ${file}`);
        } else {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, content);
            out.println(`gen-genesis-tools-rpc-swift: wrote ${file}`);
        }
    }
}
if (import.meta.main) {
    writeOrCheckGenesisToolsRPC();
}
