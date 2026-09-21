import ApplicationServices
import AppKit
import CoreText
import Foundation
import Vision

// MARK: - Main

let args = CommandLine.arguments
if args.count < 2 || args[1] == "--help" || args[1] == "-h" {
    let help = """
    ax-tool — fast AX API CLI for macOS UI automation

    Use see → act → see for snapshot-scoped computer use. Inspection never activates
    an app. Actions validate the observed app/window/tree before dispatch. preflight
    remains available for legacy discovery and screen metadata.

    Usage:
      ax-tool see --app <name> [--window-index N | --window-id ID] [--depth 20] [--scope window|chrome] [--path shot.png]
                      Indexed AX tree + exact-window PNG + 120-second snapshot token; multiple windows require an index.
      ax-tool act --app <name> --snapshot TOKEN --element N --action ACTION
                      ACTION: get|press|click|move|drag|set|perform|focus|scroll|type|key|select|paste
                      set: --value TEXT; perform: --ax-action AXName; type: --text TEXT (single line, max 256 UTF-16 units); key: --keys cmd,a
                      click: --button left|right|middle; --double
                      drag: --to x,y [--duration 0.1–5]; left-button only, destination in the snapshot window
                      click/move/drag/scroll: --coords x,y replaces --element; --background skips explicit activation and pointer movement
                      move sends a window-addressed hover event; named cursor storage is provided by tools control cursor
                      scroll: --direction up|down|left|right [--pages 1–20 | --pixels 1–10000]
                              pages use observed viewport dimensions (default: one page); pixels use an exact wheel distance
                      select: --text TEXT [--prefix TEXT] [--suffix TEXT] OR --range utf16Start,length
                              [--selection text|cursor_before|cursor_after]
                      paste: --text TEXT [--format text|md|html]; restores clipboard unless another writer changes it
                      Refuses stale app/window/tree/index. No automatic retries or focus. Refresh with see after action.
      ax-tool preflight --app <name> [--depth <n>] [--wanted g1,g2]  Discover everything (see above)
                        --wanted groups: screens,frontmost,windows,elements,browser,plan
                        (elements truncated 15/role; --wanted elements:<Role> = full one role)
      ax-tool apps [--all]                                    List running apps (valid --app values)
      ax-tool front                                           On-screen windows front to back with owner pid/app (no --app)
      ax-tool permissions                                     Live Accessibility + Screen Recording state of THIS process (never prompts)
      ax-tool audit [--all]                                   Which running apps carry AXManualAccessibility / AXEnhancedUserInterface
                      (read-only: never resolves an app, so it cannot set the flag it reports)
      ax-tool list    --app <name> [--depth <n=10>]           List elements (flat, max 2000)
      ax-tool tree    --app <name> [--depth <n=10>]           Hierarchical tree (nested JSON)
      ax-tool dump    --app <name>                            Windows + on-screen elements, scroll-clipped
      ax-tool typography --app <name>                         Rendered font + sRGB rgba per static text
      ax-tool hittest --at <x,y>                              Which element gets a click at that point
                      (screen coordinates; takes no --app)
      ax-tool get     --app <name> <target>                    Read element attributes
      ax-tool set     --app <name> <target> --value <v>       Set + HARD VERIFY (reads field back, 1 retry)
      ax-tool press   --app <name> <target>                   Press (AXPress) an element
      ax-tool attrs   --app <name> <target>                   List ALL attributes + values
      ax-tool actions --app <name> <target>                   List available AX actions
      ax-tool perform --app <name> <target> --action <a>      Perform any AX action
      ax-tool find    --app <name> [--role R] [--title T] [--value V] [--desc D] [--subrole S]
                      [--text Q] [--q Q] [--window W] [--exact]
      ax-tool window  --app <name> [--action move|resize|minimize|maximize|close|focus] [--no-raise]
                      --no-raise: act on the window without pulling it forward first
      ax-tool focus   --app <name> [<target>] [--no-activate] Activate app + focus element
                      --no-activate: focus WITHOUT raising the app (never steals the user's window)
      ax-tool click   --app <name> <target>                   CGEvent click at element center
      ax-tool type    --app <name> --text <str> [<target>]    Type + HARD VERIFY ([--clear] [--end] [--return])
                      (inserts at the CURRENT cursor; --end jumps to end first, --clear replaces all)
      ax-tool scroll  --app <name> [<target>|--coords x,y] --direction up|down|left|right [--amount n]
                      (no --direction + target = AXScrollToVisible: bring element into view)
      ax-tool screenshot --app <name> --path <file.png> [--window W | --window-id ID] [--crop x,y,w,h] [--annotate [--all]]
                      --crop is PIXELS of the captured image; --window fails loud on 0/2+ matches
                      --annotate draws numbered boxes on interactable elements + legend in JSON
      ax-tool ocr     --app <name> [--window W | --window-id ID] | --image <path> [--crop x,y,w,h]   Vision OCR: text blocks + pixel boxes
      ax-tool capture --mode window|screen|region [--app <name> | --window-id ID] [--window-title T] [--window-index N]
                      [--screen-index N] [--region x,y,w,h] --duration <seconds> [--active-fps 8] [--idle-fps 2]
                      [--threshold 2.5] [--video-out f.mp4] [--out DIR]   ScreenCaptureKit recording: change-sampled
                      keep-NNNN.png frames, contact.png, metadata.json; JSON result in the capture-runner shape
      ax-tool screens                                         Displays in NSScreen order: index, name, scale, position, resolution
      ax-tool hotkey --keys <cmd,a> [--app <name>]            Key combo (--app activates target first)
      ax-tool snapshot                                        Capture mouse + focused app/window
      ax-tool restore --snapshot <json>                       Restore mouse + focus from snapshot
      ax-tool record [--out <f.jsonl>] [--duration <s>]       Stream user activity as NDJSON
                      (clicks resolved to AX elements; keys; scrolls; SIGINT to stop)

    Safety flags: --to-pid <pid> confines synthetic key/mouse events to ONE process
    instead of the global HID tap (an invalid value is rejected, never downgraded).
    --no-activate / --no-raise keep automation from stealing the user's window.

    Target: --id <axId>, --q <query> (universal cascade), or any combo of
    --role/--title/--desc/--subrole [--window W] [--exact].
    Elements WITHOUT AXIdentifier are fully interactable via desc/role/subrole.
    NOTE: many apps (Chromium browsers, SwiftUI) put visible text in
    AXDescription, not AXTitle — when --title finds nothing, try --desc or --q.

    Output: compact JSON to stdout (--pretty to indent). {"ok":true,...} on
    success, {"ok":false,"error":"..."} on failure.
    set/type refuse when the target app is not frontmost, and verify the field
    content after typing (retry once, then fail loud with fieldValue).
    Permission: requires Accessibility for the responsible process; `tools control` routes every
    call through GenesisTools.app, so that is the identity to grant. Missing grant = a distinct
    {"reason":"accessibility-not-granted"} error, never "no windows".

    Examples:
      ax-tool preflight --app Genesis
      ax-tool apps
      ax-tool find --app "Brave Browser" --q "YouTube" --depth 10
      ax-tool click --app "Brave Browser" --desc "youtube" --role AXRadioButton
      ax-tool press --app Genesis --desc "Account" --role AXButton
      ax-tool set --app Genesis --id auth-email --value "user@example.com"
      ax-tool screenshot --app Genesis --window "Genesis" --path /tmp/g.png --crop 0,0,1800,300
      ax-tool hotkey --keys cmd,w --app "Brave Browser"
      ax-tool window --app Finder --action move --x 100 --y 100
      ax-tool hittest --at 640,480
      ax-tool typography --app Genesis
      ax-tool focus --app Genesis --id auth-email --no-activate
      ax-tool type --app Genesis --text hi --to-pid 4213
    """
    print(help)
    exit(args.count < 2 ? 2 : 0)
}

let command = args[1]

func argValue(_ flag: String) -> String? {
    guard let idx = args.firstIndex(of: flag), idx + 1 < args.count else { return nil }
    return args[idx + 1]
}

if command == "cursor-feedback" {
    runCursorFeedbackCommand()
    exit(0)
}
if command == "permissions" {
    cmdPermissions()
    exit(0)
}
if command == "audit" {
    cmdAudit()
    exit(0)
}
if command == "apps" {
    if args.contains("--installed") { cmdInstalledApps() } else { cmdApps() }
    exit(0)
}
if command == "launch-app" {
    cmdLaunchApp()
    exit(0)
}
if command == "quit-app" {
    cmdQuitApp()
    exit(0)
}

// Every command from here on reads or drives an AX tree, posts events, or taps input, and all
// of those need Accessibility. Without it the AX API answers every app with an empty window
// list, which every command used to report as a fact about the target ("no windows for X").
// The exceptions read no AX state: `screens` (NSScreen), `capture` (ScreenCaptureKit, gated
// on Screen Recording inside Record.swift) and `ocr --image` (a file on disk).
let axFreeCommands: Set<String> = ["screens", "capture"]
if !axFreeCommands.contains(command) && !(command == "ocr" && argValue("--image") != nil) {
    requireAxTrust()
}

if command == "snapshot" {
    cmdSnapshot()
    exit(0)
}
if command == "restore" {
    guard let snap = argValue("--snapshot") else { errorExit("--snapshot <json> required") }
    cmdRestore(snapshotJson: snap)
    exit(0)
}
if command == "hotkey" {
    guard let keys = argValue("--keys") else { errorExit("--keys required (e.g. cmd,a)") }
    cmdHotkey(keys: keys)
    exit(0)
}

if command == "ocr", let _ = argValue("--image") {
    cmdOcr(appName: nil)
    exit(0)
}
if command == "record" {
    cmdRecord()
    exit(0)
}
// `hittest` asks the window server what is under a SCREEN point — it does not resolve an
// app, so requiring `--app` here made the documented `ax-tool hittest --at 640,480` unusable.
if command == "hittest" {
    guard let raw = argValue("--at"), case let parts = raw.split(separator: ","), parts.count == 2,
          let hx = Double(parts[0]), let hy = Double(parts[1]) else {
        errorExit("hittest requires --at <x,y>")
    }
    cmdHitTest(x: hx, y: hy)
    exit(0)
}

// `screens` has no app, and `capture` needs one only in window mode.
if command == "screens" {
    cmdScreens()
    exit(0)
}
if command == "capture" {
    cmdCaptureScreen()
    exit(0)
}
// `front` lists every on-screen window, so it takes no app either.
if command == "front" {
    cmdFront()
    exit(0)
}
// `activate` brings one already-running app to the front, named by pid so the caller acts on the
// process it observed rather than on whatever now answers to a name.
if command == "activate" {
    cmdActivate()
    exit(0)
}

guard let appName = argValue("--app") else {
    errorExit("--app <name> required")
}

let maxDepth = Int(argValue("--depth") ?? "10") ?? 10

switch command {
case "menu-see", "menu-act":
    cmdMenu(command)
case "wait-change":
    cmdWaitChange(appName: appName)
case "control-session":
    cmdControlSession(appName: appName)
case "see":
    cmdSee(appName: appName)
case "act":
    cmdAct(appName: appName)
case "list":
    cmdList(appName: appName, maxDepth: maxDepth)
case "tree":
    cmdTree(appName: appName, maxDepth: maxDepth)
case "get":
    cmdGet(appName: appName)
case "set":
    guard let value = argValue("--value") else { errorExit("--value required") }
    cmdSet(appName: appName, value: value)
case "press":
    cmdPress(appName: appName)
case "attrs":
    cmdAttrs(appName: appName)
case "actions":
    cmdActions(appName: appName)
case "perform":
    guard let action = argValue("--action") else { errorExit("--action required") }
    cmdPerform(appName: appName, action: action)
case "find":
    let findQ = argValue("--q")
    let findText = argValue("--text")
    cmdFind(appName: appName, role: argValue("--role"), title: argValue("--title"),
            value: argValue("--value"), desc: argValue("--desc"),
            subrole: argValue("--subrole"), text: findText ?? findQ,
            searchAll: findQ != nil, exact: args.contains("--exact"), maxDepth: maxDepth)
case "window":
    cmdWindow(appName: appName)
case "focus":
    cmdFocus(appName: appName)
case "click":
    cmdClick(appName: appName)
case "scroll":
    cmdScroll(appName: appName)
case "type":
    guard let text = argValue("--text") else { errorExit("--text required") }
    cmdTypeText(appName: appName, text: text)
case "dump":
    cmdDump(appName: appName)
case "typography":
    cmdTypography(appName: appName)
case "preflight":
    cmdPreflight(appName: appName, maxDepth: maxDepth)
case "ocr":
    cmdOcr(appName: appName)
case "screenshot":
    guard let path = argValue("--path") else { errorExit("--path <file.png> required") }
    cmdScreenshot(appName: appName, path: path)
default:
    errorExit("unknown command: \(command). Use: list, tree, dump, typography, hittest, get, set, press, attrs, actions, perform, find, window, focus, click, type, scroll, hotkey, screenshot, ocr, preflight, apps, permissions, audit, snapshot, restore, record, capture, screens")
}
