// Reads and presses accessibility elements of one process, including windows that are not on screen (a
// `GenesisTools --clicky --headless` Settings window has alpha 0, so `tools control see` refuses it).
//
//   swiftc -O scripts/native/ax.swift -o <scratch>/ax
//   <scratch>/ax tree <pid> [max-depth]          one line per element: depth, role, identifier, title, value
//   <scratch>/ax press <pid> <identifier>        AXPress on the one element with this identifier
//   <scratch>/ax value <pid> <identifier>        print that element's value
//   <scratch>/ax json <pid>                      every element with a role and a label, as JSON lines
//   <scratch>/ax press-titled <pid> <role> <title>   AXPress on the one element with this role and title
//
// The process running it needs the Accessibility grant (the terminal, or GenesisTools.app when run through tools).
import ApplicationServices
import Foundation

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func text(_ element: AXUIElement, _ name: String) -> String {
    guard let value = attribute(element, name) else { return "" }
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number.stringValue }
    return ""
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func walk(_ element: AXUIElement, depth: Int, maxDepth: Int, visit: (AXUIElement, Int) -> Bool) -> Bool {
    if visit(element, depth) { return true }
    guard depth < maxDepth else { return false }
    for child in children(element) where walk(child, depth: depth + 1, maxDepth: maxDepth, visit: visit) {
        return true
    }
    return false
}

func find(pid: pid_t, identifier: String) -> [AXUIElement] {
    var matches: [AXUIElement] = []
    _ = walk(AXUIElementCreateApplication(pid), depth: 0, maxDepth: 60) { element, _ in
        if text(element, kAXIdentifierAttribute) == identifier { matches.append(element) }
        return false
    }
    return matches
}

func find(pid: pid_t, role: String, title: String) -> [AXUIElement] {
    var matches: [AXUIElement] = []
    _ = walk(AXUIElementCreateApplication(pid), depth: 0, maxDepth: 60) { element, _ in
        if text(element, kAXRoleAttribute) == role, text(element, kAXTitleAttribute) == title { matches.append(element) }
        return false
    }
    return matches
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3, let pid = pid_t(args[2]) else {
    fail("usage: ax tree <pid> [max-depth] | ax press <pid> <identifier> | ax value <pid> <identifier>")
}
guard AXIsProcessTrusted() else { fail("this process lacks the Accessibility grant") }

switch args[1] {
case "tree":
    let maxDepth = args.count > 3 ? Int(args[3]) ?? 40 : 40
    _ = walk(AXUIElementCreateApplication(pid), depth: 0, maxDepth: maxDepth) { element, depth in
        let fields = [kAXRoleAttribute, kAXIdentifierAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                      kAXValueAttribute].map { text(element, $0) }
        if fields.dropFirst().contains(where: { !$0.isEmpty }) {
            print("\(depth)\t" + fields.map { $0.replacingOccurrences(of: "\n", with: " ") }.joined(separator: "\t"))
        }
        return false
    }
case "json":
    _ = walk(AXUIElementCreateApplication(pid), depth: 0, maxDepth: 60) { element, depth in
        let row: [String: Any] = [
            "depth": depth, "role": text(element, kAXRoleAttribute), "id": text(element, kAXIdentifierAttribute),
            "title": text(element, kAXTitleAttribute), "value": text(element, kAXValueAttribute),
            "enabled": (attribute(element, kAXEnabledAttribute) as? Bool) ?? true,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: row), let line = String(data: data, encoding: .utf8) {
            print(line)
        }
        return false
    }
case "press-titled":
    guard args.count >= 5 else { fail("usage: ax press-titled <pid> <role> <title>") }
    let matches = find(pid: pid, role: args[3], title: args[4])
    guard matches.count == 1 else { fail("\(matches.count) \(args[3]) elements are titled \(args[4])") }
    let result = AXUIElementPerformAction(matches[0], kAXPressAction as CFString)
    guard result == .success else { fail("AXPress failed: \(result.rawValue)") }
    print("pressed \(args[3]) \(args[4])")
case "press", "value":
    guard args.count >= 4 else { fail("missing identifier") }
    let matches = find(pid: pid, identifier: args[3])
    guard matches.count == 1 else { fail("\(matches.count) elements carry the identifier \(args[3])") }
    if args[1] == "value" {
        print(text(matches[0], kAXValueAttribute))
    } else {
        let result = AXUIElementPerformAction(matches[0], kAXPressAction as CFString)
        guard result == .success else { fail("AXPress failed: \(result.rawValue)") }
        print("pressed \(args[3])")
    }
default:
    fail("unknown verb \(args[1])")
}
