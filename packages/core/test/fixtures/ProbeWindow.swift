// Test app for the computer-use e2e test: one window with a text field and a button that report what happens to
// stdout. It never activates itself, so it stays in the background like a window the human shared.
import AppKit

/** Top-left origin, so the list starts at its top and "scroll down" increases the offset. */
final class FlippedView: NSView {
  override var isFlipped: Bool { true }
}

final class Probe: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
  var window: NSWindow!
  var field: NSTextField!

  func applicationDidFinishLaunching(_ n: Notification) {
    window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 460, height: 360), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    window.title = "Godmode Probe"
    // Open on the Space the human is looking at (a background app's window would otherwise land on its own Space).
    window.collectionBehavior = [.moveToActiveSpace]
    field = NSTextField(frame: NSRect(x: 20, y: 290, width: 420, height: 28))
    field.delegate = self
    field.target = self
    field.action = #selector(submitted)
    field.placeholderString = "Type here"
    let button = NSButton(frame: NSRect(x: 20, y: 230, width: 180, height: 32))
    button.title = "Press me"
    button.bezelStyle = .rounded
    button.target = self
    button.action = #selector(pressed)
    // A scrollable list (content 2000 pt tall) in the bottom 200 pt that reports its scroll offset.
    let scroll = NSScrollView(frame: NSRect(x: 20, y: 10, width: 420, height: 200))
    scroll.hasVerticalScroller = true
    let doc = FlippedView(frame: NSRect(x: 0, y: 0, width: 400, height: 2000))
    scroll.documentView = doc
    scroll.contentView.postsBoundsChangedNotifications = true
    NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { _ in
      print("SCROLL \(Int(scroll.contentView.bounds.origin.y))")
      fflush(stdout)
    }
    window.contentView!.addSubview(field)
    window.contentView!.addSubview(button)
    window.contentView!.addSubview(scroll)
    window.orderFrontRegardless()
    print("READY \(window.windowNumber) \(ProcessInfo.processInfo.processIdentifier)")
    fflush(stdout)
  }

  @objc func pressed() { print("BUTTON_PRESSED"); fflush(stdout) }
  @objc func submitted() { print("ENTER \(field.stringValue)"); fflush(stdout) }
  func controlTextDidChange(_ obj: Notification) { print("TEXT \(field.stringValue)"); fflush(stdout) }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let probe = Probe()
app.delegate = probe
// Safety net: never outlive the test.
DispatchQueue.main.asyncAfter(deadline: .now() + 180) { exit(0) }
app.run()
