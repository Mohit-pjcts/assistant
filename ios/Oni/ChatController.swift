import Foundation
import Observation
import OniCore

/// Owns the phone-local chats and runs one turn at a time.
@MainActor @Observable
final class ChatController {
    private static let modelKey = "chatModel"

    private let app: AppModel
    private let store: ChatStore

    private(set) var chats: [Chat]
    private(set) var isRunning = false
    /// The reply as it streams, before it is committed to the chat.
    private(set) var liveText = ""
    /// What Oni is doing right now ("Searching the vault…"), for the visible
    /// in-flight indicator — nothing runs in the background without showing.
    private(set) var activity: String?
    private(set) var errorMessage: String?
    private(set) var hasKey: Bool

    private var run: AgentRun?

    var model: ClaudeModel {
        didSet { UserDefaults.standard.set(model.rawValue, forKey: Self.modelKey) }
    }

    init(app: AppModel) {
        self.app = app
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        store = ChatStore(directory: support.appendingPathComponent("Chats", isDirectory: true))
        chats = store.load().sorted { $0.updatedAt > $1.updatedAt }
        hasKey = Keychain.get(.anthropicKey) != nil
        model = UserDefaults.standard.string(forKey: Self.modelKey).flatMap(ClaudeModel.init(rawValue:)) ?? .haiku
    }

    func chat(_ id: UUID) -> Chat? { chats.first { $0.id == id } }

    /// Everything the phone's Oni has spent, estimated.
    var totalCost: Double { chats.reduce(0) { $0 + $1.cost } }

    // MARK: Key

    func saveKey(_ key: String) {
        let cleaned = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        Keychain.set(cleaned, for: .anthropicKey)
        hasKey = true
        errorMessage = nil
    }

    func removeKey() {
        Keychain.delete(.anthropicKey)
        hasKey = false
    }

    // MARK: Chats

    @discardableResult
    func newChat() -> UUID {
        let chat = Chat(model: model)
        chats.insert(chat, at: 0)
        persist()
        return chat.id
    }

    func delete(_ id: UUID) {
        if isRunning, currentID == id { stop() }
        chats.removeAll { $0.id == id }
        persist()
    }

    // MARK: Running a turn

    private var currentID: UUID?

    func send(_ text: String, in id: UUID) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isRunning, let index = chats.firstIndex(where: { $0.id == id }) else { return }
        guard let key = Keychain.get(.anthropicKey) else {
            errorMessage = ClaudeError.noKey.errorDescription
            hasKey = false
            return
        }
        var history = chats[index].messages
        history.append(Chat.userMessage(trimmed))
        chats[index].apply(committed: history)
        persist()
        start(history, key: key, in: id)
    }

    /// True when the last turn failed before Oni replied: the chat ends on the
    /// user's own message, so it can be resent as-is (after switching VPN, say).
    func canRetry(_ id: UUID) -> Bool {
        guard !isRunning, errorMessage != nil, let last = chat(id)?.messages.last else { return false }
        return last["role"]?.string == "user"
    }

    func retry(in id: UUID) {
        guard canRetry(id), let chat = chat(id) else { return }
        guard let key = Keychain.get(.anthropicKey) else {
            errorMessage = ClaudeError.noKey.errorDescription
            hasKey = false
            return
        }
        start(chat.messages, key: key, in: id)
    }

    private func start(_ history: [JSONValue], key: String, in id: UUID) {
        errorMessage = nil
        liveText = ""
        activity = "Thinking…"
        isRunning = true
        currentID = id

        var semantic: VaultToolbox.Semantic?
        if let server = app.server {
            semantic = { query in try await server.search(query) }
        }
        let toolbox = VaultToolbox(replica: app.replica, semantic: semantic)
        let agent = ChatAgent(client: AnthropicHTTPClient(apiKey: key), toolbox: toolbox)
        let run = agent.run(history: history, model: model)
        self.run = run
        let usedModel = model

        Task { [weak self] in
            var previous = Usage()
            for await event in run.events {
                guard let self else { return }
                switch event {
                case .textDelta(let t):
                    liveText += t
                    activity = "Writing…"
                case .toolStarted(let name):
                    activity = Transcript.activity(forTool: name)
                case .toolFinished(_, _, let wrote):
                    if wrote {
                        await app.refreshLocal()
                        app.scheduleSync()
                    }
                    activity = "Thinking…"
                    liveText = ""
                case .usage(let total):
                    // The agent reports a running total; the chat wants the delta.
                    var delta = total
                    delta.inputTokens -= previous.inputTokens
                    delta.outputTokens -= previous.outputTokens
                    delta.cacheCreationTokens -= previous.cacheCreationTokens
                    delta.cacheReadTokens -= previous.cacheReadTokens
                    previous = total
                    record(delta, model: usedModel, in: id)
                case .committed(let messages):
                    update(id) { $0.apply(committed: messages) }
                    liveText = ""
                case .finished(let finish):
                    finishRun(finish, id: id)
                }
            }
        }
    }

    func stop() { run?.stop() }

    private func finishRun(_ finish: Finish, id: UUID) {
        isRunning = false
        activity = nil
        liveText = ""
        run = nil
        currentID = nil
        switch finish {
        case .done, .stopped: break
        case .breaker(let tool): errorMessage = "Stopped: \(tool) kept failing the same way."
        case .callLimit: errorMessage = "Stopped after \(ChatAgent.Limit.modelCalls) steps in one turn."
        case .refused: errorMessage = "Anthropic declined to answer that."
        case .truncated: errorMessage = "The reply was cut off by the length limit."
        case .failure(let message):
            // Never touch the saved key because a request failed: a 403 is a region
            // block and a dead VPN looks like an outage; neither means the key is bad.
            errorMessage = message
        }
        persist()
    }

    private func record(_ usage: Usage, model: ClaudeModel, in id: UUID) {
        update(id) { $0.record(usage, model: model) }
    }

    private func update(_ id: UUID, _ change: (inout Chat) -> Void) {
        guard let i = chats.firstIndex(where: { $0.id == id }) else { return }
        change(&chats[i])
    }

    private func persist() {
        chats.sort { $0.updatedAt > $1.updatedAt }
        try? store.save(chats)
    }
}
