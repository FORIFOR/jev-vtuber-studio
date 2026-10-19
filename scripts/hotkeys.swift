// Global hotkeys for the Live Control Panel (docs/CONTROL.md, NOA Studio Phase 6). Registers the keys given as
// arguments (F6, Ctrl+Shift+M, ...) with Carbon's RegisterEventHotKey, which needs no Accessibility permission, and
// prints each press as its name on stdout ("ready <key>" once registered). scripts/global-hotkeys.mjs runs it and turns
// presses into Studio actions. No key is logged or sent anywhere else.
import AppKit
import Carbon

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
setvbuf(stdout, nil, _IOLBF, 0)

let functionKeys: [String: Int] = ["F1": kVK_F1, "F2": kVK_F2, "F3": kVK_F3, "F4": kVK_F4, "F5": kVK_F5, "F6": kVK_F6, "F7": kVK_F7,
    "F8": kVK_F8, "F9": kVK_F9, "F10": kVK_F10, "F11": kVK_F11, "F12": kVK_F12, "F13": kVK_F13, "F14": kVK_F14, "F15": kVK_F15,
    "F16": kVK_F16, "F17": kVK_F17, "F18": kVK_F18, "F19": kVK_F19]
let characterKeys: [String: Int] = ["A": kVK_ANSI_A, "B": kVK_ANSI_B, "C": kVK_ANSI_C, "D": kVK_ANSI_D, "E": kVK_ANSI_E, "F": kVK_ANSI_F,
    "G": kVK_ANSI_G, "H": kVK_ANSI_H, "I": kVK_ANSI_I, "J": kVK_ANSI_J, "K": kVK_ANSI_K, "L": kVK_ANSI_L, "M": kVK_ANSI_M, "N": kVK_ANSI_N,
    "O": kVK_ANSI_O, "P": kVK_ANSI_P, "Q": kVK_ANSI_Q, "R": kVK_ANSI_R, "S": kVK_ANSI_S, "T": kVK_ANSI_T, "U": kVK_ANSI_U, "V": kVK_ANSI_V,
    "W": kVK_ANSI_W, "X": kVK_ANSI_X, "Y": kVK_ANSI_Y, "Z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
    "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9]
let modifierKeys: [String: Int] = ["Ctrl": controlKey, "Alt": optionKey, "Shift": shiftKey, "Cmd": cmdKey]

/** "Ctrl+Shift+M" -> (key code, modifiers), or nil. */
func parse(_ name: String) -> (UInt32, UInt32)? {
    let parts = name.split(separator: "+").map(String.init)
    guard let last = parts.last, let code = functionKeys[last] ?? characterKeys[last] else { return nil }
    var mods = 0
    for part in parts.dropLast() { guard let m = modifierKeys[part] else { return nil }; mods |= m }
    return (UInt32(code), UInt32(mods))
}

var names: [UInt32: String] = [:]
var refs: [EventHotKeyRef?] = []
var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
    var id = EventHotKeyID()
    GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
    if let name = names[id.id] { print(name) }
    return noErr
}, 1, &pressed, nil, nil)

for (i, name) in CommandLine.arguments.dropFirst().enumerated() {
    guard let (code, mods) = parse(name) else { FileHandle.standardError.write("unknown key \(name)\n".data(using: .utf8)!); continue }
    var ref: EventHotKeyRef?
    let id = EventHotKeyID(signature: OSType(0x4E4F4131), id: UInt32(i + 1)) // 'NOA1'
    let status = RegisterEventHotKey(code, mods, id, GetApplicationEventTarget(), 0, &ref)
    if status == noErr { names[UInt32(i + 1)] = name; refs.append(ref); print("ready \(name)") }
    else { FileHandle.standardError.write("could not register \(name) (\(status)); another app may use it\n".data(using: .utf8)!) }
}
app.run()
