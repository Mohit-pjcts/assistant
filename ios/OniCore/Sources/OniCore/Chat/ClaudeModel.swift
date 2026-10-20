import Foundation

/// Token counts for one or more API calls.
public struct Usage: Codable, Sendable, Equatable {
    public var inputTokens = 0
    public var outputTokens = 0
    public var cacheCreationTokens = 0
    public var cacheReadTokens = 0

    public init(inputTokens: Int = 0, outputTokens: Int = 0, cacheCreationTokens: Int = 0, cacheReadTokens: Int = 0) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheCreationTokens = cacheCreationTokens
        self.cacheReadTokens = cacheReadTokens
    }

    public mutating func add(_ other: Usage) {
        inputTokens += other.inputTokens
        outputTokens += other.outputTokens
        cacheCreationTokens += other.cacheCreationTokens
        cacheReadTokens += other.cacheReadTokens
    }

    /// Everything sent as prompt, cached or not.
    public var promptTokens: Int { inputTokens + cacheCreationTokens + cacheReadTokens }
}

/// The two models the phone offers. Prices are Anthropic's per-million-token
/// rates as of 2026-10-06 (the claude-api reference); the cost counter is an
/// estimate from them, never an invoice.
public enum ClaudeModel: String, CaseIterable, Codable, Sendable, Identifiable {
    case haiku = "claude-haiku-5-5"
    case sonnet = "claude-sonnet-5-5"

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .haiku: "Haiku 5.5 (cheap)"
        case .sonnet: "Sonnet 5.5 (smarter)"
        }
    }

    /// Thinking is left at the model's default and steered with effort, since
    /// Sonnet 5.5 rejects `thinking: disabled` outright. A vault assistant
    /// has little to gain from deep reasoning, so effort stays low.
    public var effort: String {
        switch self {
        case .haiku: "low"
        case .sonnet: "medium"
        }
    }

    func rates(promptTokens: Int) -> (input: Double, output: Double) {
        switch self {
        case .haiku: promptTokens > 100_000 ? (0.50, 2.50) : (0.10, 0.50)
        case .sonnet: (2.00, 10.00)
        }
    }

    /// Estimated dollars. Cache writes cost 1.25x input, cache reads 0.1x.
    public func cost(of usage: Usage) -> Double {
        let r = rates(promptTokens: usage.promptTokens)
        let input = Double(usage.inputTokens) * r.input
            + Double(usage.cacheCreationTokens) * r.input * 1.25
            + Double(usage.cacheReadTokens) * r.input * 0.1
        return (input + Double(usage.outputTokens) * r.output) / 1_000_000
    }
}

public enum ClaudeError: Error, LocalizedError, Equatable {
    case noKey
    case invalidKey
    case blocked
    case rateLimited(retryAfter: Int?)
    case overloaded
    case offline(String)
    case api(status: Int, message: String)
    case stream(String)

    public var errorDescription: String? {
        switch self {
        case .noKey: "Add your Anthropic API key in Settings to chat with Oni."
        case .invalidKey: "Anthropic rejected the API key (401). It is still saved; re-enter it in Settings only if it was changed."
        case .blocked: "Anthropic refused the request (403), usually a region block. Turn on your VPN (or use Tailscale with the Mac as exit node) and tap Retry. Your key is still saved."
        case .rateLimited(let s): s.map { "Rate limited by Anthropic. Try again in \($0)s." } ?? "Rate limited by Anthropic. Try again shortly."
        case .overloaded: "Anthropic is overloaded right now. Try again in a moment."
        case .offline(let detail): "Can't reach Anthropic (\(detail)). Check your connection and VPN, then tap Retry."
        case .api(let status, let message): "Anthropic error \(status): \(message)"
        case .stream(let message): "The reply was interrupted: \(message)"
        }
    }
}
