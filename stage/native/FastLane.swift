// Stage fast lane (used by the Backstage agents): clicks and text inserts straight through the macOS accessibility API.
//
// Why: Cua Driver runs every action through one input lane in its daemon (measured: ~0.6 s per click, and two apps
// at the same time take as long as one after the other). The same AXPress sent directly takes 2-4 ms, and two apps
// can be worked at the same time. Cua stays in charge of everything else (reading windows, web typing, keys, pixel
// clicks, launching, the foreground fallback), and of these two actions whenever the fast lane can't do them.
//
// Protocol: one JSON request per line on stdin, one JSON reply per line on stdout (requests run concurrently).
//   {"id":1,"op":"press","pid":123,"x":10,"y":20,"w":40,"h":30,"role":"AXButton","label":"7",
//    "windowId":4567,"winTitle":"Calculator","wx":0,"wy":0,"ww":300,"wh":400,"deadline":1759500000123}
//   {"id":2,"op":"type", ...same..., "text":"hello"}
//   -> {"id":1,"ok":true,"ms":3.1,"how":"hit-test"}  or  {"id":1,"ok":false,"error":"..."}
//      or {"id":1,"ok":false,"uncertain":true,"error":"..."}: the action MAY have happened (never redo it blindly)
// On start it prints {"ready":true,"trusted":true|false}. Not trusted = no Accessibility permission: use Cua.
//
// Safety:
// * an element is only acted on if it is in the agent's window (CGWindowID, else that window's frame AND title), and
//   its role, frame (within 3 points) and label (exact, normalized title / description / placeholder) match what the
//   agent saw. Empty and class-name-like labels ("ICMNoteListCell") are refused: Cua acts by element token instead.
// * deadline (epoch ms): checked right before acting; a request that is too late is skipped, never done late (the
//   caller has stopped waiting for it by then).
// * text is only inserted into native fields (never inside a web page, where the page wouldn't notice the change),
//   at the END of the text with nothing selected (never over a selection), and only reported as done if the field's
//   value really changed.
import AppKit
import ApplicationServices

/// private but long-stable (used by many window managers): the CGWindowID of an AXWindow element
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

let out = FileHandle.standardOutput
let writeLock = NSLock()
func reply(_ d: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: d) else { return }
  writeLock.lock()
  out.write(data)
  out.write("\n".data(using: .utf8)!)
  writeLock.unlock()
}

func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
}
func frame(_ e: AXUIElement) -> CGRect? {
  guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute) else { return nil }
  var pt = CGPoint.zero, sz = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
  return CGRect(origin: pt, size: sz)
}
func near(_ a: CGRect, _ b: CGRect, _ tol: CGFloat = 3) -> Bool {
  abs(a.minX - b.minX) <= tol && abs(a.minY - b.minY) <= tol && abs(a.width - b.width) <= tol && abs(a.height - b.height) <= tol
}
let bidi = "[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]"
func norm(_ s: String) -> String {
  s.replacingOccurrences(of: bidi, with: "", options: .regularExpression).lowercased()
    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
}
/// labels that can't tell elements apart: empty, or internal names shared by many elements (every Notes row is "ICMNoteListCell")
func unusableLabel(_ s: String) -> Bool {
  let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
  if t.isEmpty { return true }
  if t.range(of: "^_NS:\\d+$", options: .regularExpression) != nil || t.hasPrefix("_SC_") { return true }
  return t.range(of: "^[A-Z]{2,}[A-Za-z]+(Cell|View|Row|Item)[A-Za-z]*$", options: .regularExpression) != nil
}
func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

struct Target {
  let pid: pid_t, rect: CGRect, role: String, label: String
  /// the agent's window: its CGWindowID (0 = unknown) and, as the fallback check, its frame and title
  let windowId: CGWindowID, winFrame: CGRect?, winTitle: String?
  var center: CGPoint { CGPoint(x: rect.midX, y: rect.midY) }

  /// role, frame and an EXACT normalized label (title, description or placeholder; never value or identifier)
  func matches(_ e: AXUIElement) -> Bool {
    guard attr(e, kAXRoleAttribute) as? String == role, let f = frame(e), near(f, rect) else { return false }
    let want = norm(label)
    if want.isEmpty { return false }
    for a in [kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue"] {
      if let v = attr(e, a) as? String, norm(v) == want { return true }
    }
    return false
  }

  /// is this AXWindow the agent's window?
  func isTargetWindow(_ w: AXUIElement) -> Bool {
    var id: CGWindowID = 0
    if windowId != 0, _AXUIElementGetWindow(w, &id) == .success, id != 0 { return id == windowId }
    // no window id from accessibility: the window's frame AND title must both match what the agent read
    guard let wf = winFrame, let wt = winTitle, let f = frame(w), near(f, wf) else { return false }
    return norm(attr(w, kAXTitleAttribute) as? String ?? "") == norm(wt)
  }

  /// the element belongs to the agent's window (not to another window of the same app with the same layout)
  func inTargetWindow(_ e: AXUIElement) -> Bool {
    guard let w = attr(e, kAXWindowAttribute) else { return false }
    return isTargetWindow(w as! AXUIElement)
  }
}

/** the element the agent meant, in the agent's window: hit-test at its centre and walk up, else a pruned search of that window */
func locate(_ t: Target) -> (AXUIElement, String)? {
  let app = AXUIElementCreateApplication(t.pid)
  AXUIElementSetMessagingTimeout(app, 1.0)
  var hit: AXUIElement?
  if AXUIElementCopyElementAtPosition(app, Float(t.center.x), Float(t.center.y), &hit) == .success, var e = hit {
    for _ in 0..<8 {
      // the hit-test finds whatever is on top at that point: a same-looking element in another window of the same app
      // (the user's own maximised Safari window in front of the agent's) is rejected here
      if t.matches(e) { if t.inTargetWindow(e) { return (e, "hit-test") }; break }
      guard let p = attr(e, kAXParentAttribute) else { break }
      e = p as! AXUIElement
    }
  }
  // covered by another window, the hit-test landed on a sibling, or the element is taller than what is visible (a
  // long document's text area): search the agent's window only, descending only into elements that overlap the target
  guard let win = ((attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).first(where: { t.isTargetWindow($0) }) else { return nil }
  let start = CFAbsoluteTimeGetCurrent()
  var budget = 5000
  func search(_ e: AXUIElement, _ depth: Int) -> AXUIElement? {
    budget -= 1
    if budget <= 0 || depth > 40 || CFAbsoluteTimeGetCurrent() - start > 0.3 { return nil }
    if t.matches(e) { return e }
    if let f = frame(e), f.width > 0, !f.insetBy(dx: -2, dy: -2).intersects(t.rect) { return nil }
    for c in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { if let found = search(c, depth + 1) { return found } }
    return nil
  }
  if let found = search(win, 0), t.inTargetWindow(found) { return (found, "search") }
  return nil
}

func insideWebPage(_ e: AXUIElement) -> Bool {
  var cur: AXUIElement? = e
  for _ in 0..<40 {
    guard let c = cur else { return false }
    if attr(c, kAXRoleAttribute) as? String == "AXWebArea" { return true }
    cur = attr(c, kAXParentAttribute).map { $0 as! AXUIElement }
  }
  return false
}

func selectedRange(_ e: AXUIElement) -> CFRange? {
  guard let v = attr(e, kAXSelectedTextRangeAttribute) else { return nil }
  var r = CFRange(location: 0, length: 0)
  return AXValueGetValue(v as! AXValue, .cfRange, &r) ? r : nil
}

func handle(_ r: [String: Any]) {
  let id = r["id"] ?? 0
  let t0 = CFAbsoluteTimeGetCurrent()
  func done(_ ok: Bool, _ extra: [String: Any] = [:]) {
    var d: [String: Any] = ["id": id, "ok": ok, "ms": ((CFAbsoluteTimeGetCurrent() - t0) * 10000).rounded() / 10]
    for (k, v) in extra { d[k] = v }
    reply(d)
  }
  let op = r["op"] as? String ?? ""
  if op == "ping" { return done(true, ["trusted": AXIsProcessTrusted()]) }
  let num = { (k: String) -> Double in (r[k] as? NSNumber)?.doubleValue ?? 0 }
  // never act after the deadline: the caller has stopped waiting by then (no deadline = act now)
  let deadline = (r["deadline"] as? NSNumber)?.doubleValue ?? Double.infinity
  let late = { nowMs() > deadline }
  if late() { return done(false, ["error": "deadline passed before start: skipped"]) }
  guard let pid = (r["pid"] as? NSNumber)?.int32Value, let role = r["role"] as? String else { return done(false, ["error": "bad request"]) }
  let label = r["label"] as? String ?? ""
  if unusableLabel(label) { return done(false, ["error": "no usable label to verify the element by"]) }
  let windowId = (r["windowId"] as? NSNumber)?.uint32Value ?? 0
  let winFrame: CGRect? = num("ww") > 0 && num("wh") > 0 ? CGRect(x: num("wx"), y: num("wy"), width: num("ww"), height: num("wh")) : nil
  let winTitle = r["winTitle"] as? String
  if windowId == 0 && (winFrame == nil || winTitle == nil) { return done(false, ["error": "no window to check the element against"]) }
  let t = Target(pid: pid, rect: CGRect(x: num("x"), y: num("y"), width: num("w"), height: num("h")), role: role, label: label,
                 windowId: windowId, winFrame: winFrame, winTitle: winTitle)
  guard t.rect.width > 0, t.rect.height > 0 else { return done(false, ["error": "no frame"]) }
  guard let (e, how) = locate(t) else { return done(false, ["error": "element not found in the agent's window where the agent saw it"]) }
  AXUIElementSetMessagingTimeout(e, 0.5) // bounds how long the action itself can block

  switch op {
  case "press":
    if late() { return done(false, ["error": "deadline passed: skipped"]) }
    let err = AXUIElementPerformAction(e, kAXPressAction as CFString)
    if err == .success { return done(true, ["how": how]) }
    // -25205 (cannot complete) is also what a timed-out call returns: the press may or may not have happened
    if err == .cannotComplete { return done(false, ["uncertain": true, "how": how, "error": "AXPress could not complete (-25205): it may have happened"]) }
    return done(false, ["error": "AXPress refused (\(err.rawValue))"])
  case "type":
    let text = r["text"] as? String ?? ""
    if insideWebPage(e) { return done(false, ["error": "inside a web page: needs key events"]) }
    guard let before = attr(e, kAXValueAttribute) as? String else { return done(false, ["error": "the field's text can't be read"]) }
    let end = (before as NSString).length // AX text ranges count UTF-16 units
    // never type over a selection: the insert goes at the end of the text, with nothing selected
    guard let sel = selectedRange(e) else { return done(false, ["error": "the field's selection can't be read"]) }
    if !(sel.location == end && sel.length == 0) {
      if late() { return done(false, ["error": "deadline passed: skipped"]) }
      var caret = CFRange(location: end, length: 0)
      guard let v = AXValueCreate(.cfRange, &caret),
            AXUIElementSetAttributeValue(e, kAXSelectedTextRangeAttribute as CFString, v) == .success,
            let now = selectedRange(e), now.location == end, now.length == 0 else {
        return done(false, ["error": "could not put the cursor at the end of the text with nothing selected"])
      }
    }
    if late() { return done(false, ["error": "deadline passed: skipped"]) }
    let err = AXUIElementSetAttributeValue(e, kAXSelectedTextAttribute as CFString, text as CFString)
    if err == .cannotComplete { return done(false, ["uncertain": true, "how": how, "error": "insert could not complete (-25205): it may have happened"]) }
    guard err == .success else { return done(false, ["error": "insert refused (\(err.rawValue))"]) }
    let after = attr(e, kAXValueAttribute) as? String
    // only "done" if the field really changed (some fields accept the write and ignore it)
    if let a = after, a != before, text.isEmpty || a.contains(text) { return done(true, ["how": how]) }
    return done(false, ["error": "the field did not change"])
  default:
    return done(false, ["error": "unknown op \(op)"])
  }
}

reply(["ready": true, "trusted": AXIsProcessTrusted()])
let work = DispatchQueue(label: "fastlane", attributes: .concurrent)
while let line = readLine() {
  guard let d = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
  work.async { handle(d) }
}
