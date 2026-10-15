import Foundation

// Keyboard-first review: the diff page posts a `key` message for j k r e x f n p s while the diff has the
// keyboard and no box, composer or find field is focused. The host keeps the state and acts.

public enum ReviewKey: String {
    case nextThread = "j"
    case previousThread = "k"
    case reply = "r"
    case resolve = "e"
    case select = "x"
    case fix = "f"
    case nextFile = "n"
    case previousFile = "p"
    case submit = "s"
}
