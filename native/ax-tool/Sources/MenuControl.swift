import AppKit
import ApplicationServices
import Foundation
import SnapshotSupport

private func menuArguments(_ command: String) throws -> [String:String] {
    let values: Set<String> = command == "menu-see" ? ["--app","--menu"] : ["--app","--snapshot","--element","--action"]
    var parsed: [String:String] = [:]
    let input = Array(args.dropFirst(2))
    var index = 0
    while index < input.count {
        if input[index] == "--no-cursor" { index += 1; continue }
        guard values.contains(input[index]), index + 1 < input.count, parsed[input[index]] == nil else {
            throw SnapshotError.invalid("invalid or duplicate menu argument: " + input[index])
        }
        parsed[input[index]] = input[index + 1]
        index += 2
    }
    guard parsed["--app"] != nil else { throw SnapshotError.invalid("--app required") }
    return parsed
}
private struct MenuBarHierarchy: HierarchySource {
    let root: AXUIElement
    let base = LiveHierarchySource()
    func attribute(_ element: AXUIElement, _ name: String) -> Any? { base.attribute(element,name) }
    func actionNames(of element: AXUIElement) -> [String] { base.actionNames(of:element) }
    func isValueSettable(_ element: AXUIElement) -> Bool? { base.isValueSettable(element) }
    func children(of element: AXUIElement) throws -> [AXUIElement] {
        return CFEqual(element,root) ? try base.children(of:element) : []
    }
}
private func menuTree(_ pid: pid_t, depth: Int, rootTitle: String?) throws -> ObservedTreeData {
    let app = AXUIElementCreateApplication(pid)
    guard let raw = axAttribute(app, kAXMenuBarAttribute as String),
          CFGetTypeID(raw) == AXUIElementGetTypeID() else {
        throw ObservedTreeError("application does not expose a menu bar")
    }
    let bar = raw as! AXUIElement
    if let title = rootTitle {
        let matches = try LiveHierarchySource().children(of:bar).filter { axStringAttribute($0,"AXTitle") == title }
        guard matches.count == 1 else { throw ObservedTreeError("top-level menu title is missing or ambiguous") }
        return try buildObservedTree(root:matches[0],source:LiveHierarchySource(),depth:depth,scope:"menu")
    }
    return try buildObservedTree(root:bar,source:MenuBarHierarchy(root:bar),depth:depth,scope:"menu")
}
func cmdMenu(_ command: String) {
    var started = false
    do {
        let input = try menuArguments(command)
        let appName = input["--app"]!
        var token: MenuSnapshotToken?
        var index = 0
        if command == "menu-act" {
            guard let raw = input["--snapshot"], raw.count < 65536, let data = Data(base64Encoded:raw),
                  let decoded = try? JSONDecoder().decode(MenuSnapshotToken.self,from:data),
                  let rawIndex = input["--element"], let selected = Int(rawIndex), selected >= 0 else {
                throw SnapshotError.invalid("menu-act requires a menu snapshot and current element index")
            }
            token = decoded
            index = selected
        }
        let pid = resolveApp(appName)
        let launch = try observedLaunch(pid)
        if let token {
            try token.validate(pid:pid,launch:launch,digest:token.digest,element:index,count:4000,now:Date().timeIntervalSince1970)
        }
        let rootTitle = token?.rootTitle ?? input["--menu"]
        let tree = try menuTree(pid,depth:token?.depth ?? 40,rootTitle:rootTitle)
        if command == "menu-see" {
            let token = MenuSnapshotToken(pid:pid,launch:launch,depth:40,digest:tree.digest,created:Date().timeIntervalSince1970,rootTitle:rootTitle)
            let raw = try JSONEncoder().encode(token).base64EncodedString()
            jsonOutput(["ok":true,"app":appName,"pid":pid,"processLaunch":launch,"surface":"menu","snapshot":raw,
                        "elements":tree.rows.map { $0.filter { $0.key != "identity" } }])
            return
        }
        guard let token, tree.elements.indices.contains(index) else {
            throw SnapshotError.refusal(.missingTarget,"menu index outside current observation")
        }
        let element = tree.elements[index]
        let action = input["--action"] ?? "AXPress"
        guard axActionNames(element).contains(action) else { throw SnapshotError.invalid("menu item does not expose the requested AX action") }
        try dispatchMenuAction(token:token,pid:pid,launch:launch,digest:tree.digest,element:index,count:tree.elements.count,
            now:Date().timeIntervalSince1970,frontmost:frontmostPid() == pid,
            enabled:(axAttribute(element,"AXEnabled") as? NSNumber)?.boolValue != false) {
            AXUIElementSetMessagingTimeout(element,3)
            let frame = axFrame(element)
            if frame.width > 0, frame.height > 0 {
                ActionCursor.emit("press",point:CGPoint(x:frame.midX,y:frame.midY),background:false,target:"ax")
            } else {
                ActionCursor.emit("press", point: nil)
            }
            let fresh = try menuTree(pid, depth: token.depth, rootTitle: rootTitle)
            _ = try token.validate(pid: pid, launch: observedLaunch(pid), digest: fresh.digest,
                element: index, count: fresh.elements.count, now: Date().timeIntervalSince1970)
            guard frontmostPid() == pid else { throw SnapshotError.refusal(.focusMismatch, "menu lost focus while presenting cursor") }
            started = true
            let result = AXUIElementPerformAction(element,action as CFString)
            guard result == .success else { throw ObservedTreeError("menu action failed or timed out (AX \(result.rawValue)); inspect before doing anything else") }
        }
        jsonOutput(["ok":true,"surface":"menu","action":action,"element":index,"pid":pid,
                    "dispatchState":"dispatched","refreshRequired":true])
    } catch {
        jsonOutput(["ok":false,"error":error.localizedDescription,"dispatchState":started ? "uncertain" : "not_started",
                    "refusal":(error as? SnapshotError)?.category.rawValue ?? "refused"])
        exit(1)
    }
}
