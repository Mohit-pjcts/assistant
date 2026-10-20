import Foundation

/// One model call: everything that varies per request.
public struct ChatRequest: Sendable {
    public var model: ClaudeModel
    public var system: String
    public var tools: [JSONValue]
    public var messages: [JSONValue]
    public var maxTokens: Int

    public init(model: ClaudeModel, system: String, tools: [JSONValue], messages: [JSONValue], maxTokens: Int = 8192) {
        self.model = model
        self.system = system
        self.tools = tools
        self.messages = messages
        self.maxTokens = maxTokens
    }
}

/// Where model calls go. A protocol so the agent loop is tested against a
/// scripted fake and only the smoke test touches the real API.
public protocol ModelClient: Sendable {
    func complete(
        _ request: ChatRequest,
        onOutput: @Sendable (StreamAssembler.Output) -> Void
    ) async throws -> AssembledMessage
}

/// Raw HTTPS to `api.anthropic.com` (there is no official Swift SDK).
public struct AnthropicHTTPClient: ModelClient {
    private let apiKey: String
    private let session: URLSession
    private let endpoint: URL

    public init(
        apiKey: String, session: URLSession = .shared,
        endpoint: URL = URL(string: "https://api.anthropic.com/v1/messages")!
    ) {
        self.apiKey = apiKey
        self.session = session
        self.endpoint = endpoint
    }

    /// The request body. Cache breakpoints sit on the end of the system prompt
    /// and the last tool, so the large, never-changing prefix is read from cache
    /// on every later call in a turn (a block under the model's minimum
    /// cacheable size is simply not cached; that is silent, not an error).
    public static func body(for request: ChatRequest) throws -> Data {
        var tools = request.tools
        if var last = tools.popLast()?.object {
            last["cache_control"] = ["type": "ephemeral"]
            tools.append(.object(last))
        }
        let body: JSONValue = [
            "model": .string(request.model.rawValue),
            "max_tokens": .number(Double(request.maxTokens)),
            "stream": true,
            "system": [["type": "text", "text": .string(request.system), "cache_control": ["type": "ephemeral"]]],
            "tools": .array(tools),
            "output_config": ["effort": .string(request.model.effort)],
            "messages": .array(request.messages),
        ]
        return try body.encoded()
    }

    public func complete(
        _ request: ChatRequest,
        onOutput: @Sendable (StreamAssembler.Output) -> Void
    ) async throws -> AssembledMessage {
        var urlRequest = URLRequest(url: endpoint, timeoutInterval: 90)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        urlRequest.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        urlRequest.setValue("application/json", forHTTPHeaderField: "content-type")
        urlRequest.httpBody = try Self.body(for: request)

        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await session.bytes(for: urlRequest)
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch let e as URLError {
            throw ClaudeError.offline(e.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw ClaudeError.stream("no HTTP response") }

        if http.statusCode != 200 {
            var text = ""
            for try await line in bytes.lines { text += line }
            throw Self.error(status: http.statusCode, body: text, retryAfter: http.value(forHTTPHeaderField: "retry-after"))
        }

        var assembler = StreamAssembler()
        do {
            for try await line in bytes.lines {
                guard line.hasPrefix("data:") else { continue }
                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                for output in try assembler.consume(data: payload) { onOutput(output) }
            }
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch let e as URLError {
            throw ClaudeError.stream(e.localizedDescription)
        }
        return try assembler.message()
    }

    static func error(status: Int, body: String, retryAfter: String?) -> ClaudeError {
        let message = JSONValue.parse(body)?["error"]?["message"]?.string ?? String(body.prefix(200))
        switch status {
        case 401: return .invalidKey
        // Anthropic answers 403 to unsupported regions (e.g. Hong Kong without a VPN),
        // which says nothing about the key itself.
        case 403: return .blocked
        case 429: return .rateLimited(retryAfter: retryAfter.flatMap(Int.init))
        case 529: return .overloaded
        default: return .api(status: status, message: message)
        }
    }
}
