// Drags the real pointer along one axis: mouse down at the start, through each target at 120 events/s, mouse up.
// Usage: drag <x|y> <fixed coordinate> <start> <target> <seconds> [<target> <seconds> ...]
import CoreGraphics
import Foundation

let all = Array(CommandLine.arguments.dropFirst())
let vertical = all[0] == "y"
let args = all.dropFirst().compactMap { Double($0) }
let fixed = args[0]
var value = args[1]
let source = CGEventSource(stateID: .hidSystemState)
func point(_ v: Double) -> CGPoint { vertical ? CGPoint(x: fixed, y: v) : CGPoint(x: v, y: fixed) }
func post(_ type: CGEventType) {
    CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point(value), mouseButton: .left)?.post(tap: .cghidEventTap)
}
post(.mouseMoved)
usleep(250_000)
post(.leftMouseDown)
usleep(120_000)
var index = 2
while index + 1 < args.count {
    let target = args[index], seconds = args[index + 1]
    let steps = max(1, Int(seconds * 120))
    let start = value
    for step in 1...steps {
        value = start + (target - start) * Double(step) / Double(steps)
        post(.leftMouseDragged)
        usleep(useconds_t(1_000_000 / 120))
    }
    index += 2
}
usleep(120_000)
post(.leftMouseUp)
