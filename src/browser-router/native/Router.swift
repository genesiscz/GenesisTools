import Foundation

/// The retired standalone "Genesis Router.app"; a config may still name it.
let browserRouterBundleID = "com.genesiscz.genesistools.browser-router"
/// Bundles that route links: forwarding to one of them would loop.
private let linkRouterBundleIDsForLoopGuard = [browserRouterBundleID, "com.genesiscz.genesistools"]
private let toolNamePattern = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9-]*$")

struct NormalizedBrowser: Codable, Equatable {
    var name: String
    var appType: String
    var openInBackground: Bool
}

struct RouteDecision: Codable, Equatable {
    var kind: String
    var original: String
    var url: String
    var browser: NormalizedBrowser?
    var openArguments: [String]
    var via: String
    var routeIndex: Int?
    var tool: String?
    var args: [String]?
    var approval: String?
    var needsApproval: Bool?
    var argv: [String]? = nil
    var open: String? = nil
    var notify: String? = nil
    var browserArguments: [String]? = nil
    var touchId: Bool = false
}

enum RouteFailure: Error, CustomStringConvertible {
    case message(String)
    var description: String {
        switch self {
        case .message(let text):
            return text
        }
    }
}

func configDirectory() -> URL {
    let override = ProcessInfo.processInfo.environment["GENESIS_TOOLS_HOME"]
    let root = override.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.homeDirectoryForCurrentUser
    return root.appendingPathComponent(".genesis-tools/browser-router", isDirectory: true)
}

func loadConfigData() throws -> Data {
    let url = configDirectory().appendingPathComponent("config.json")
    if !FileManager.default.fileExists(atPath: url.path) {
        throw RouteFailure.message("no config at \(url.path)")
    }
    return try Data(contentsOf: url)
}

func routeURL(_ raw: String, configData: Data, allowUnwrap: Bool = true) throws -> RouteDecision {
    try routeParsed(raw, config: try parseConfig(configData), allowUnwrap: allowUnwrap)
}

private func routeParsed(_ raw: String, config: ParsedConfig, allowUnwrap: Bool) throws -> RouteDecision {
    let cleaned = config.clean ? cleanLink(raw) : raw
    guard let original = URL(string: cleaned), let scheme = original.scheme, !scheme.isEmpty else {
        throw RouteFailure.message("url is not a URL: \(raw)")
    }
    if let direct = try matchRoutes(raw, href: original.absoluteString, config: config, allowUnwrap: allowUnwrap) {
        return direct
    }
    if let aliased = try aliasURL(original, aliases: config.aliases), aliased.absoluteString != original.absoluteString,
       let second = try matchRoutes(raw, href: aliased.absoluteString, config: config, allowUnwrap: allowUnwrap) {
        return second
    }
    if let service = serviceMatch(original, services: config.services) {
        let opened = try forward(config.defaultBrowser, url: original.absoluteString, original: raw, via: "route", routeIndex: nil)
        return RouteDecision(
            kind: "run", original: raw, url: original.absoluteString, browser: opened.browser,
            openArguments: [], via: "route", routeIndex: nil, tool: nil, args: nil, approval: "allow",
            needsApproval: false, argv: ["tools", "browser-router", "ensure", String(service.port)],
            open: original.absoluteString, notify: "Starting \(service.name)", browserArguments: opened.openArguments,
            touchId: false
        )
    }
    return try forward(config.defaultBrowser, url: original.absoluteString, original: raw, via: "default", routeIndex: nil)
}

private func serviceMatch(_ url: URL, services: [ServiceRef]) -> ServiceRef? {
    guard url.scheme == "http" || url.scheme == "https" else { return nil }
    guard url.host == "localhost" || url.host == "127.0.0.1" else { return nil }
    guard let port = url.port, port != 6666 else { return nil }
    return services.first { $0.port == port }
}

private func matchRoutes(_ raw: String, href: String, config: ParsedConfig, allowUnwrap: Bool) throws -> RouteDecision? {
    for rule in config.routes {
        let index = rule.index
        if !allowUnwrap, case .unwrap = rule.action { continue }
        let expression = try compile(rule.pattern)
        let range = NSRange(href.startIndex..., in: href)
        guard let found = expression.firstMatch(in: href, range: range), found.range.location != NSNotFound else {
            continue
        }
        return try apply(rule.action, match: found, href: href, raw: raw, config: config, routeIndex: index)
    }
    return nil
}

private func cleanLink(_ raw: String) -> String {
    guard var components = URLComponents(string: raw), let host = components.host?.lowercased() else { return raw }
    // queryItems values are already percent-decoded: decoding again would turn %26 into &.
    let param = { (name: String) in components.queryItems?.first(where: { $0.name == name })?.value }
    if onDomain(host, "safelinks.protection.outlook.com"), let inner = param("url"), inner.hasPrefix("http") {
        return cleanLink(inner)
    }
    if (host == "www.google.com" || host == "google.com"), components.path == "/url", let inner = param("q"), inner.hasPrefix("http") {
        return cleanLink(inner)
    }
    if onDomain(host, "slack.com") || onDomain(host, "teams.microsoft.com"), let inner = param("url") ?? param("q"), inner.hasPrefix("http") {
        return cleanLink(inner)
    }
    let drop: (String) -> Bool = { $0.hasPrefix("utm_") || $0 == "fbclid" || $0 == "gclid" || $0 == "mc_eid" }
    let items = components.queryItems ?? []
    let kept = items.filter { !drop($0.name) }
    if kept.count == items.count {
        return raw
    }
    components.queryItems = kept.isEmpty ? nil : kept
    return components.url?.absoluteString ?? raw
}

/// The domain itself or a subdomain of it; `notslack.com` is not `slack.com`.
private func onDomain(_ host: String, _ domain: String) -> Bool {
    host == domain || host.hasSuffix(".\(domain)")
}

/// Same rule as `applyAlias` in route.ts: the first alias whose host matches rewrites the URL onto its base.
private func aliasURL(_ url: URL, aliases: [AliasRef]) throws -> URL? {
    guard let host = url.host?.lowercased(), let alias = aliases.first(where: { $0.host.lowercased() == host }) else {
        return nil
    }
    // `new URL(base)` in route.ts throws on a base that is not an absolute URL; so does this.
    guard let base = URL(string: alias.base.hasSuffix("/") ? alias.base : "\(alias.base)/"), base.scheme != nil else {
        throw RouteFailure.message("aliases: base \(alias.base) for \(alias.host) is not an absolute URL")
    }
    // The percent-encoded parts, as `pathname`/`search`/`hash` in route.ts: `url.path` is decoded, so a
    // wrapped link's inner `%26` came out as `&` after the unwrap decoded it a second time.
    let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
    let path = parts?.percentEncodedPath ?? url.path
    let query = parts?.percentEncodedQuery.map { "?\($0)" } ?? ""
    let fragment = parts?.percentEncodedFragment.map { "#\($0)" } ?? ""
    return URL(string: "\(path)\(query)\(fragment)", relativeTo: base)?.absoluteURL
}

func decisionJSON(_ decision: RouteDecision) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return String(decoding: try encoder.encode(decision), as: UTF8.self)
}

private struct ServiceRef {
    var port: Int
    var name: String
}

private struct AliasRef {
    var host: String
    var base: String
}

/// The default when a config has no `aliases` key (`defaultAliases()` in route.ts).
private let defaultAliasRefs = [AliasRef(host: "genesis.tools", base: "https://127.0.0.1:6666")]

private struct ParsedConfig {
    var defaultBrowser: BrowserInput
    var routes: [ParsedRoute]
    var services: [ServiceRef]
    /// Empty when `allowAliases` is false.
    var aliases: [AliasRef]
    var clean: Bool
}

private struct ParsedRoute {
    /// Position in the config's `routes` array, kept when an earlier route is skipped (the toast
    /// looks the route up by this index).
    var index: Int
    var pattern: String
    var action: ParsedAction
}

private enum ParsedAction {
    case open(to: String)
    case forward(to: String?, browser: BrowserInput)
    case unwrap
    case token
    case run(argv: [String], approval: String, open: String?, notify: String?, touchId: Bool)
    case tool(tool: String, args: [String], approval: String)
}

private enum BrowserInput {
    case name(String)
    case spec(name: String, appType: String?, openInBackground: Bool)
}

private func parseConfig(_ data: Data) throws -> ParsedConfig {
    let parsed = try JSONSerialization.jsonObject(with: data)
    guard let object = parsed as? [String: Any] else {
        throw RouteFailure.message("config must be an object")
    }
    guard let browser = object["defaultBrowser"] else {
        throw RouteFailure.message("config.defaultBrowser is required")
    }
    let routes = object["routes"] as? [Any] ?? []
    if object["routes"] != nil && object["routes"] as? [Any] == nil {
        throw RouteFailure.message("config.routes must be an array")
    }
    return ParsedConfig(
        defaultBrowser: try parseBrowser(browser, label: "defaultBrowser"),
        // One route this build cannot parse (a newer action type, a typo) is skipped, never fatal:
        // failing the whole config made every link on the Mac fall back (2026-09-24, a `token` route
        // in an app built before `token` existed).
        routes: routes.enumerated().compactMap { index, value in
            do {
                return try parseRoute(value, index: index)
            } catch {
                FileHandle.standardError.write(Data("router: skipped \(error)\n".utf8))
                return nil
            }
        },
        services: parseServices(object["services"]),
        aliases: object["allowAliases"] as? Bool == false ? [] : try parseAliases(object["aliases"]),
        clean: object["clean"] as? Bool ?? true
    )
}

private func parseServices(_ value: Any?) -> [ServiceRef] {
    guard let rows = value as? [Any] else { return [] }
    return rows.compactMap { row in
        guard let object = row as? [String: Any], let port = object["port"] as? Int, let name = object["name"] as? String else {
            return nil
        }
        return ServiceRef(port: port, name: name)
    }
}

private func parseAliases(_ value: Any?) throws -> [AliasRef] {
    guard let value else { return defaultAliasRefs }
    guard let rows = value as? [Any] else {
        throw RouteFailure.message("config.aliases must be an array")
    }
    return try rows.enumerated().map { index, row in
        guard let object = row as? [String: Any], let host = object["host"] as? String, let base = object["base"] as? String else {
            throw RouteFailure.message("aliases[\(index)] needs host and base")
        }
        return AliasRef(host: host, base: base)
    }
}

private func parseRoute(_ value: Any, index: Int) throws -> ParsedRoute {
    guard let object = value as? [String: Any], let pattern = object["pattern"] as? String, !pattern.isEmpty else {
        throw RouteFailure.message("routes[\(index)] needs a pattern")
    }
    _ = try compile(pattern)
    guard let action = object["action"] as? [String: Any], let type = action["type"] as? String else {
        throw RouteFailure.message("routes[\(index)].action needs a type")
    }
    return ParsedRoute(index: index, pattern: pattern, action: try parseAction(action, type: type, index: index))
}

private func parseAction(_ value: [String: Any], type: String, index: Int) throws -> ParsedAction {
    if type == "open" {
        guard let to = value["to"] as? String, !to.isEmpty else {
            throw RouteFailure.message("routes[\(index)].action.to is required")
        }
        return .open(to: to)
    }
    if type == "forward" {
        guard let browser = value["browser"] else {
            throw RouteFailure.message("routes[\(index)].action.browser is required")
        }
        let to = value["to"] as? String
        if value["to"] != nil && to == nil {
            throw RouteFailure.message("routes[\(index)].action.to must be a string")
        }
        return .forward(to: to, browser: try parseBrowser(browser, label: "routes[\(index)].browser"))
    }
    if type == "unwrap" { return .unwrap }
    if type == "token" { return .token }
    if type == "run" {
        guard let argv = value["argv"] as? [String], !argv.isEmpty else {
            throw RouteFailure.message("routes[\(index)].action.argv must be a non-empty list of strings")
        }
        let approval = value["approval"] as? String ?? "ask"
        if approval != "ask" && approval != "allow" {
            throw RouteFailure.message("routes[\(index)].action.approval must be ask or allow")
        }
        let open = value["open"] as? String
        let notify = value["notify"] as? String
        if value["open"] != nil && open == nil { throw RouteFailure.message("routes[\(index)].action.open must be a string") }
        if value["notify"] != nil && notify == nil { throw RouteFailure.message("routes[\(index)].action.notify must be a string") }
        let touchId = value["touchId"] as? Bool ?? false
        return .run(argv: argv, approval: approval, open: open, notify: notify, touchId: touchId)
    }
    if type == "tool" {
        guard let tool = value["tool"] as? String, toolNamePattern.firstMatch(in: tool, range: NSRange(tool.startIndex..., in: tool)) != nil else {
            throw RouteFailure.message("routes[\(index)].action.tool must be a tool name")
        }
        guard let args = value["args"] as? [String] else {
            throw RouteFailure.message("routes[\(index)].action.args must be a list of strings")
        }
        let approval = value["approval"] as? String ?? "ask"
        if approval != "ask" && approval != "allow" {
            throw RouteFailure.message("routes[\(index)].action.approval must be ask or allow")
        }
        return .tool(tool: tool, args: args, approval: approval)
    }
    throw RouteFailure.message("routes[\(index)].action.type must be open, forward, unwrap, run, or tool")
}

private func parseBrowser(_ value: Any, label: String) throws -> BrowserInput {
    if let name = value as? String {
        if name.isEmpty { throw RouteFailure.message("\(label) is empty") }
        return .name(name)
    }
    guard let object = value as? [String: Any], let name = object["name"] as? String, !name.isEmpty else {
        throw RouteFailure.message("\(label) needs a name")
    }
    let appType = object["appType"] as? String
    if let appType, !["appName", "bundleId", "path", "none"].contains(appType) {
        throw RouteFailure.message("\(label).appType is not appName, bundleId, path, or none")
    }
    let background = object["openInBackground"] as? Bool ?? false
    if object["openInBackground"] != nil && object["openInBackground"] as? Bool == nil {
        throw RouteFailure.message("\(label).openInBackground must be a boolean")
    }
    return .spec(name: name, appType: appType, openInBackground: background)
}

private func compile(_ pattern: String) throws -> NSRegularExpression {
    var source = pattern
    if !source.hasPrefix("^") { source = "^(?:\(source))" }
    if !source.hasSuffix("$") { source = "\(source)(?:\\?[^#]*)?(?:#.*)?$" }
    do {
        return try NSRegularExpression(pattern: source)
    } catch {
        throw RouteFailure.message("pattern /\(pattern)/ is not a regular expression (\(error))")
    }
}

private func apply(_ action: ParsedAction, match: NSTextCheckingResult, href: String, raw: String, config: ParsedConfig, routeIndex: Int) throws -> RouteDecision {
    let url = URL(string: href)
    switch action {
    case .token:
        let id = capture(1, href: href, match: match)
        return RouteDecision(
            kind: "run", original: raw, url: raw, browser: nil, openArguments: [], via: "route",
            routeIndex: routeIndex, tool: nil, args: nil, approval: "allow", needsApproval: false,
            argv: ["tools", "browser-router", "token", "open", id], open: nil, notify: nil,
            browserArguments: [], touchId: false
        )
    case .unwrap:
        let encoded = capture(1, href: href, match: match)
        guard let decoded = encoded.removingPercentEncoding else {
            throw RouteFailure.message("wrapped link is not encoded")
        }
        let inner = try routeParsed(decoded, config: config, allowUnwrap: false)
        if inner.via != "default" {
            var copy = inner
            copy.original = raw
            return copy
        }
        guard let parsed = URL(string: decoded), let scheme = parsed.scheme else {
            throw RouteFailure.message("wrapped link is not a URL: \(decoded)")
        }
        if scheme != "http" && scheme != "https" {
            if scheme == "genesis-md" {
                let browser = NormalizedBrowser(name: "dev.foltyn.genesis.markdown", appType: "bundleId", openInBackground: false)
                return RouteDecision(
                    kind: "open", original: raw, url: decoded, browser: browser, openArguments: openArguments(browser, decoded),
                    via: "route", routeIndex: routeIndex, tool: nil, args: nil, approval: nil, needsApproval: nil
                )
            }
            // A /link/ URL arrives from any app with no prompt, so it may only open http(s) and genesis-md.
            throw RouteFailure.message("wrapped link uses \(scheme):, and only http(s) and genesis-md links are unwrapped")
        }
        var copy = inner
        copy.original = raw
        return copy
    case .run(let argv, let approval, let open, let notify, let touchId):
        var filled = fillArgs(argv, href: href, match: match, url: url)
        let launch = try launchQuery(url, argv: filled)
        // Joined with "=", as route.ts does: a lone "--verbose" is taken by the `tools` root, not by launch.
        for arg in launch?.runArgs ?? [] { filled.append("--run-arg=\(arg)") }
        for arg in launch?.extra ?? [] { filled.append("--claude-arg=\(arg)") }
        // A clicked link that carries an agent prompt always asks (route.ts `asks`). Only a minted link
        // redeemed by `tools browser-router token open` may skip the card, and that runs in TypeScript.
        let asks = launch?.hasPrompt == true || approval == "ask"
        var browserArguments: [String] = []
        var openValue: String? = nil
        if let open {
            let target = substitute(open, href: href, match: match, url: url)
            // Same rule as parseOpenTarget in route.ts: `URL(string:)` accepts a relative `report.html`,
            // `new URL()` does not, and the browser only gets absolute http(s).
            guard let parsed = URL(string: target), let scheme = parsed.scheme?.lowercased() else {
                throw RouteFailure.message("open target is not a URL: \(target)")
            }
            guard scheme == "http" || scheme == "https", parsed.host != nil else {
                throw RouteFailure.message("open target is not an http(s) URL: \(target)")
            }
            let forwarded = try forward(config.defaultBrowser, url: parsed.absoluteString, original: raw, via: "route", routeIndex: routeIndex)
            browserArguments = forwarded.openArguments
            openValue = target
        }
        return RouteDecision(
            kind: "run", original: raw, url: raw, browser: nil, openArguments: [], via: "route",
            routeIndex: routeIndex, tool: nil, args: nil, approval: asks ? "ask" : approval, needsApproval: asks,
            argv: filled, open: openValue, notify: notify.map { substitute($0, href: href, match: match, url: url) },
            browserArguments: browserArguments, touchId: touchId
        )
    case .tool(let tool, let args, let approval):
        return RouteDecision(
            kind: "tool", original: raw, url: raw, browser: nil, openArguments: [], via: "route",
            routeIndex: routeIndex, tool: tool, args: args.map { substitute($0, href: href, match: match, url: url) },
            approval: approval, needsApproval: true
        )
    case .forward(let to, let browser):
        let target = to.map { substitute($0, href: href, match: match, url: url) } ?? raw
        guard let parsed = URL(string: target) else { throw RouteFailure.message("forward target is not a URL: \(target)") }
        return try forward(browser, url: parsed.absoluteString, original: raw, via: "route", routeIndex: routeIndex)
    case .open(let to):
        let rewritten = substitute(to, href: href, match: match, url: url)
        guard let parsed = URL(string: rewritten), let scheme = parsed.scheme else {
            throw RouteFailure.message("open target is not a URL: \(rewritten)")
        }
        if scheme == "http" || scheme == "https" {
            return try forward(config.defaultBrowser, url: parsed.absoluteString, original: raw, via: "loop-guard", routeIndex: routeIndex)
        }
        if scheme == "genesis-md" {
            let browser = NormalizedBrowser(name: "dev.foltyn.genesis.markdown", appType: "bundleId", openInBackground: false)
            return RouteDecision(
                kind: "open", original: raw, url: rewritten, browser: browser, openArguments: openArguments(browser, rewritten),
                via: "route", routeIndex: routeIndex, tool: nil, args: nil, approval: nil, needsApproval: nil
            )
        }
        return RouteDecision(
            kind: "open", original: raw, url: rewritten, browser: nil, openArguments: [rewritten], via: "route",
            routeIndex: routeIndex, tool: nil, args: nil, approval: nil, needsApproval: nil
        )
    }
}

private func forward(_ browser: BrowserInput, url: String, original: String, via: String, routeIndex: Int?) throws -> RouteDecision {
    let normalized = normalize(browser)
    if normalized.appType == "none" {
        return RouteDecision(
            kind: "forward", original: original, url: url, browser: normalized, openArguments: [], via: via,
            routeIndex: routeIndex, tool: nil, args: nil, approval: nil, needsApproval: nil
        )
    }
    if normalized.appType == "bundleId" && linkRouterBundleIDsForLoopGuard.contains(normalized.name) {
        throw RouteFailure.message("a route cannot forward back into the browser router")
    }
    return RouteDecision(
        kind: "forward", original: original, url: url, browser: normalized, openArguments: openArguments(normalized, url),
        via: via, routeIndex: routeIndex, tool: nil, args: nil, approval: nil, needsApproval: nil
    )
}

private func fillArgs(_ templates: [String], href: String, match: NSTextCheckingResult, url: URL?) -> [String] {
    let split = try! NSRegularExpression(pattern: "^\\{([A-Za-z][A-Za-z0-9]*)\\*\\}$")
    var args: [String] = []
    for template in templates {
        let range = NSRange(template.startIndex..., in: template)
        if let found = split.firstMatch(in: template, range: range), let name = group(found, 1, template) {
            let value = queryValue(String(template[name]), url: url)
            for part in value.split(separator: ",") {
                let trimmed = part.trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty { args.append(trimmed) }
            }
            continue
        }
        args.append(substitute(template, href: href, match: match, url: url))
    }
    return args
}

/// `url` has no default: a call without it resolved every `{name}` placeholder to "" (route.ts
/// passes the URL for every action).
private func substitute(_ template: String, href: String, match: NSTextCheckingResult, url: URL?) -> String {
    let expression = try! NSRegularExpression(pattern: "\\$\\$|\\$(\\d+)|\\{([A-Za-z][A-Za-z0-9]*)\\}")
    var result = ""
    var cursor = template.startIndex
    for found in expression.matches(in: template, range: NSRange(template.startIndex..., in: template)) {
        // NSRange counts UTF-16 units and String.index(offsetBy:) counts Characters, so an emoji
        // before a placeholder shifted every later cut. Convert the range instead.
        guard let whole = Range(found.range, in: template) else { continue }
        result += template[cursor..<whole.lowerBound]
        let token = template[whole]
        if token == "$$" {
            result += "$"
        } else if let text = group(found, 1, template) {
            result += capture(Int(template[text]) ?? 0, href: href, match: match)
        } else if let text = group(found, 2, template) {
            result += placeholder(String(template[text]), url: url)
        }
        cursor = whole.upperBound
    }
    result += template[cursor...]
    return result
}

private func group(_ match: NSTextCheckingResult, _ index: Int, _ template: String) -> Range<String.Index>? {
    guard index < match.numberOfRanges else { return nil }
    let range = match.range(at: index)
    guard range.location != NSNotFound else { return nil }
    return Range(range, in: template)
}

private func placeholder(_ name: String, url: URL?) -> String {
    guard let url else { return "" }
    if name == "host" { return url.host ?? "" }
    if name == "pathname" { return url.path }
    if name == "path" { return url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path }
    if name == "port" { return url.port.map(String.init) ?? "" }
    return queryValue(name, url: url)
}

private struct LaunchQuery {
    var hasPrompt: Bool
    var runArgs: [String]
    var extra: [String]
}

private let promptCapBytes = 8_192

/// Mirrors `launchFields` in route.ts: a cmux launch link's prompt, extra agent arguments and run arguments.
private func launchQuery(_ url: URL?, argv: [String]) throws -> LaunchQuery? {
    guard let url else { return nil }
    let isLaunch = url.path.contains("/cmux/") || (argv.count > 2 && argv[0] == "tools" && argv[1] == "cmux" && argv[2] == "launch")
    guard isLaunch else { return nil }
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    let all = { (name: String) in items.filter { $0.name == name }.compactMap(\.value).filter { !$0.isEmpty } }
    let prompt = items.first { $0.name == "prompt" }?.value ?? ""
    if prompt.utf8.count > promptCapBytes {
        throw RouteFailure.message("prompt is over the 8 KB cap; use a minted link with --prompt-file")
    }
    return LaunchQuery(hasPrompt: !prompt.isEmpty, runArgs: all("run"), extra: all("arg") + all("claude-arg"))
}

private func queryValue(_ name: String, url: URL?) -> String {
    guard let url else { return "" }
    return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value ?? ""
}

private func capture(_ index: Int, href: String, match: NSTextCheckingResult) -> String {
    guard index < match.numberOfRanges else { return "" }
    let range = match.range(at: index)
    guard range.location != NSNotFound, let text = Range(range, in: href) else { return "" }
    return String(href[text])
}

private func normalize(_ input: BrowserInput) -> NormalizedBrowser {
    switch input {
    case .name(let name):
        return NormalizedBrowser(name: name, appType: inferAppType(name), openInBackground: false)
    case .spec(let name, let appType, let openInBackground):
        return NormalizedBrowser(name: name, appType: appType ?? inferAppType(name), openInBackground: openInBackground)
    }
}

private func inferAppType(_ name: String) -> String {
    if name.hasPrefix("/") || name.hasSuffix(".app") { return "path" }
    if name.contains(".") && !name.contains("/") { return "bundleId" }
    return "appName"
}

private func openArguments(_ browser: NormalizedBrowser, _ url: String) -> [String] {
    var args: [String] = []
    if browser.openInBackground { args.append("-g") }
    if browser.appType == "bundleId" {
        args.append("-b")
        args.append(browser.name)
    } else {
        args.append("-a")
        args.append(browser.name)
    }
    args.append(url)
    return args
}
