// Waterboy's bridge to Beeper's platform-imessage (github.com/beeper/platform-imessage, MIT).
//
// The Waterboy service starts this once and keeps it running: the library drives a hidden,
// secondary Messages.app instance through the Accessibility APIs (SIP stays on), and that
// instance, like a typing indicator it shows, only lives as long as this process.
//
// Protocol: one JSON object per line on stdin, one reply per line on stdout.
//   {"id":1,"op":"ping"}                                   → {"id":1,"ok":true,"accessibility":"authorized"}
//   {"id":2,"op":"typing","chat":"any;-;+16145550142","on":true}  → {"id":2,"ok":true}
//   {"id":3,"op":"react","chat":"…","message":"<message GUID>","reaction":"like"}  (heart, like, dislike,
//      laugh, emphasize, question, or any single emoji)                → {"id":3,"ok":true}
//   {"id":4,"op":"reply","chat":"…","message":"<message GUID>","text":"…"}   (threaded reply) → {"id":4,"ok":true}
//   any failure                                            → {"id":N,"ok":false,"error":"…"}
// Requests run one at a time, in order. Closing stdin (or SIGTERM) quits the hidden Messages and exits.
//
// Hidden Messages copies: when the library finds its copy unhealthy it launches a new one and asks
// the old one to quit, but an unresponsive copy ignores that (and a launch that outlasts the
// library's timeout is never tracked at all), so copies piled up. The helper therefore records
// every Messages copy that appears while it's running a library call, keeps only the newest,
// force-quits the rest, and saves the list so the next run can clean up after a crash.
// The person's own Messages (already running, or opened outside a call) is never touched.
import AppKit
import Foundation
import IMessage

let version = "0.3.0"

func reply(_ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

struct Request: Decodable {
    let id: Int
    let op: String
    let chat: String?
    let on: Bool?
    let message: String?
    let reaction: String?
    let text: String?
}

let dataDir = CommandLine.arguments.dropFirst().first
    ?? (NSTemporaryDirectory() as NSString).appendingPathComponent("waterboy-imessage")
try? FileManager.default.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
IMessageHost.bootstrapWithOptions(dataDirPath: dataDir, verbose: ProcessInfo.processInfo.environment["WATERBOY_IMESSAGE_VERBOSE"] == "1", useSecondaryInstance: true)

// Ask once, so Waterboy shows up in System Settings → Privacy & Security → Accessibility.
// (WATERBOY_IMESSAGE_NO_PROMPT=1 skips it, for tests run from a terminal.)
if MacPermissions.getAuthStatus(.accessibility) != .authorized, ProcessInfo.processInfo.environment["WATERBOY_IMESSAGE_NO_PROMPT"] != "1" {
    MacPermissions.askForAccessibilityAccess()
}

// ---------- hidden Messages copies ----------

let messagesBundleID = "com.apple.MobileSMS"
let ownedFile = (dataDir as NSString).appendingPathComponent("secondary-messages.json")

struct Owned: Codable { let pid: Int32; let launched: Double } // launch time, seconds since 1970

func runningMessages() -> [NSRunningApplication] {
    NSRunningApplication.runningApplications(withBundleIdentifier: messagesBundleID)
}

/// The copies this helper launched, oldest first.
var owned: [Owned] = []

func saveOwned() {
    if let data = try? JSONEncoder().encode(owned) { try? data.write(to: URL(fileURLWithPath: ownedFile)) }
}

/// The running app for a recorded copy, if it's still that same process (guards against pid reuse).
func app(for o: Owned) -> NSRunningApplication? {
    runningMessages().first { $0.processIdentifier == o.pid && abs(($0.launchDate?.timeIntervalSince1970 ?? 0) - o.launched) < 2 }
}

func forceQuit(_ o: Owned) {
    guard let a = app(for: o) else { return }
    if !a.forceTerminate() { kill(o.pid, SIGKILL) }
}

/// Force-quit every recorded copy except the newest (the one the library is using), or all of them.
func reap(keepNewest: Bool) {
    owned = owned.filter { app(for: $0) != nil }
    let doomed = keepNewest ? Array(owned.dropLast()) : owned
    doomed.forEach(forceQuit)
    owned = keepNewest ? Array(owned.suffix(1)) : []
    saveOwned()
}

/// Run a library call, recording any Messages copy that appears meanwhile as ours.
func tracking<T>(_ work: () async throws -> T) async throws -> T {
    let before = Set(runningMessages().map(\.processIdentifier))
    defer {
        let new = runningMessages().filter { !before.contains($0.processIdentifier) }
        owned += new.map { Owned(pid: $0.processIdentifier, launched: $0.launchDate?.timeIntervalSince1970 ?? Date().timeIntervalSince1970) }
        owned.sort { $0.launched < $1.launched }
        reap(keepNewest: true)
    }
    return try await work()
}

// Copies left by a previous run that crashed or was killed.
if let data = FileManager.default.contents(atPath: ownedFile), let previous = try? JSONDecoder().decode([Owned].self, from: data) {
    previous.forEach(forceQuit)
}
saveOwned()

let api: PlatformAPI
do {
    api = try PlatformAPI(accountID: "waterboy")
} catch {
    reply(["id": 0, "ok": false, "error": "couldn't start: \(error)"])
    exit(1)
}

func shutdown() async -> Never {
    try? await api.dispose() // asks the hidden Messages copy to quit…
    reap(keepNewest: false) // …and makes sure every copy we launched is gone
    exit(0)
}

signal(SIGTERM, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { Task { await shutdown() } }
sigterm.resume()

func handle(_ req: Request) async -> [String: Any] {
    do {
        switch req.op {
        case "ping":
            reap(keepNewest: true)
            return ["id": req.id, "ok": true, "version": version, "accessibility": MacPermissions.getAuthStatus(.accessibility).rawValue, "hiddenCopies": owned.count]
        case "typing":
            guard let chat = req.chat, !chat.isEmpty else { throw BridgeError("typing needs a chat") }
            try await tracking { try await api.sendActivityIndicator(type: req.on == false ? "none" : "typing", threadID: chat) }
            return ["id": req.id, "ok": true]
        case "react":
            guard let chat = req.chat, let message = req.message, let reaction = req.reaction, !reaction.isEmpty else {
                throw BridgeError("react needs chat, message and reaction")
            }
            try await tracking { try await api.addReaction(threadID: chat, messageID: message, reactionKey: reaction) }
            return ["id": req.id, "ok": true]
        case "reply":
            guard let chat = req.chat, let message = req.message, let text = req.text, !text.isEmpty else {
                throw BridgeError("reply needs chat, message and text")
            }
            _ = try await tracking { try await api.sendMessage(threadID: chat, text: text, filePath: nil, quotedMessageID: message) }
            return ["id": req.id, "ok": true]
        default:
            throw BridgeError("unknown op \(req.op)")
        }
    } catch {
        return ["id": req.id, "ok": false, "error": "\(error)"]
    }
}

struct BridgeError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

Task {
    do {
        for try await line in FileHandle.standardInput.bytes.lines {
            guard !line.isEmpty else { continue }
            guard let req = try? JSONDecoder().decode(Request.self, from: Data(line.utf8)) else {
                reply(["id": -1, "ok": false, "error": "bad request: \(line.prefix(200))"])
                continue
            }
            reply(await handle(req))
        }
    } catch {
        reply(["id": -1, "ok": false, "error": "stdin: \(error)"])
    }
    await shutdown()
}

dispatchMain()
