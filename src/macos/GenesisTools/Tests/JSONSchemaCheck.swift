import Foundation

/// A small JSON Schema (2020-12) checker for the keywords zod's `toJSONSchema` writes, so a Swift test can check a value
/// against the schemas TypeScript generates (src/recorder/lib/__fixtures__/service-protocol.schemas.json). `root` is
/// the document whose `$defs` a `$ref` names.
struct JSONSchemaCheck {
    let root: [String: Any]

    /// The ways `value` breaks `schema`, one sentence each with its path; empty when it fits.
    func problems(_ value: Any?, _ schema: Any, at path: String = "$") -> [String] {
        if let flag = schema as? Bool { return flag ? [] : ["\(path): nothing is allowed here"] }
        guard let schema = schema as? [String: Any] else { return [] }
        if let ref = schema["$ref"] as? String {
            guard let target = resolve(ref) else { return ["\(path): $ref \(ref) names nothing"] }
            return problems(value, target, at: path)
        }
        var found: [String] = []
        if let kinds = schema["type"] { found += typeProblems(value, kinds, path) }
        if !found.isEmpty { return found }
        if let constant = schema["const"], !Self.same(value, constant) { found.append("\(path): is not \(constant)") }
        if let options = schema["enum"] as? [Any], !options.contains(where: { Self.same(value, $0) }) {
            found.append("\(path): \(String(describing: value ?? "null")) is not one of \(options)")
        }
        if let anyOf = schema["anyOf"] as? [Any], !anyOf.contains(where: { problems(value, $0, at: path).isEmpty }) {
            found.append("\(path): fits none of anyOf")
        }
        if let oneOf = schema["oneOf"] as? [Any] {
            let fits = oneOf.filter { problems(value, $0, at: path).isEmpty }.count
            if fits != 1 { found.append("\(path): fits \(fits) of oneOf, not one") }
        }
        if let allOf = schema["allOf"] as? [Any] { found += allOf.flatMap { problems(value, $0, at: path) } }
        if let number = Self.number(value) { found += numberProblems(number, schema, path) }
        if let text = value as? String { found += stringProblems(text, schema, path) }
        if let list = value as? [Any] { found += arrayProblems(list, schema, path) }
        if let object = value as? [String: Any] { found += objectProblems(object, schema, path) }
        return found
    }

    private func resolve(_ ref: String) -> Any? {
        guard ref.hasPrefix("#/") else { return nil }
        var node: Any? = root
        for part in ref.dropFirst(2).split(separator: "/") {
            node = (node as? [String: Any])?[String(part)]
        }
        return node
    }

    private func typeProblems(_ value: Any?, _ kinds: Any, _ path: String) -> [String] {
        let names = (kinds as? [String]) ?? [(kinds as? String) ?? ""]
        let fits = names.contains { name in
            switch name {
            case "null": value == nil || value is NSNull
            case "boolean": Self.isBool(value)
            case "integer": Self.number(value).map { $0 == $0.rounded() } ?? false
            case "number": Self.number(value) != nil
            case "string": value is String
            case "array": value is [Any]
            case "object": value is [String: Any]
            default: false
            }
        }
        return fits ? [] : ["\(path): \(String(describing: value ?? "null")) is not \(names.joined(separator: " or "))"]
    }

    private func numberProblems(_ number: Double, _ schema: [String: Any], _ path: String) -> [String] {
        var found: [String] = []
        if let low = Self.number(schema["minimum"]), number < low { found.append("\(path): \(number) < minimum \(low)") }
        if let high = Self.number(schema["maximum"]), number > high { found.append("\(path): \(number) > maximum \(high)") }
        if let low = Self.number(schema["exclusiveMinimum"]), number <= low { found.append("\(path): \(number) <= \(low)") }
        if let high = Self.number(schema["exclusiveMaximum"]), number >= high { found.append("\(path): \(number) >= \(high)") }
        return found
    }

    private func stringProblems(_ text: String, _ schema: [String: Any], _ path: String) -> [String] {
        var found: [String] = []
        if let low = schema["minLength"] as? Int, text.count < low { found.append("\(path): shorter than \(low)") }
        if let high = schema["maxLength"] as? Int, text.count > high { found.append("\(path): longer than \(high)") }
        if let pattern = schema["pattern"] as? String, text.range(of: pattern, options: .regularExpression) == nil {
            found.append("\(path): \"\(text)\" does not match \(pattern)")
        }
        return found
    }

    private func arrayProblems(_ list: [Any], _ schema: [String: Any], _ path: String) -> [String] {
        var found: [String] = []
        if let low = schema["minItems"] as? Int, list.count < low { found.append("\(path): fewer than \(low) items") }
        if let high = schema["maxItems"] as? Int, list.count > high { found.append("\(path): more than \(high) items") }
        let prefix = schema["prefixItems"] as? [Any] ?? []
        for (index, item) in list.enumerated() {
            if index < prefix.count {
                found += problems(item, prefix[index], at: "\(path)[\(index)]")
            } else if let items = schema["items"] {
                found += problems(item, items, at: "\(path)[\(index)]")
            }
        }
        return found
    }

    private func objectProblems(_ object: [String: Any], _ schema: [String: Any], _ path: String) -> [String] {
        var found: [String] = []
        let properties = schema["properties"] as? [String: Any] ?? [:]
        for name in schema["required"] as? [String] ?? [] where object[name] == nil {
            found.append("\(path).\(name): is required")
        }
        for (name, value) in object {
            if let property = properties[name] {
                found += problems(value, property, at: "\(path).\(name)")
            } else if let extra = schema["additionalProperties"] {
                found += problems(value, extra, at: "\(path).\(name)")
            }
            if let names = schema["propertyNames"] { found += problems(name, names, at: "\(path) key \(name)") }
        }
        return found
    }

    private static func isBool(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    private static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, !isBool(number) else { return nil }
        return number.doubleValue
    }

    private static func same(_ a: Any?, _ b: Any) -> Bool {
        if isBool(a) || isBool(b) { return isBool(a) && isBool(b) && (a as? Bool) == (b as? Bool) }
        if let x = number(a), let y = number(b) { return x == y }
        if let x = a as? String, let y = b as? String { return x == y }
        return false
    }
}
