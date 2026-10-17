import Foundation

/// `VaultServer` over HTTPS to the Mac (`tailscale serve`), authenticated with
/// the Vault bearer token (ADR 0004).
public struct HTTPVaultServer: VaultServer {
    public let baseURL: URL
    private let token: String
    private let session: URLSession

    public init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }()

    private func request(
        _ method: String, _ path: String, query: [String: String] = [:],
        body: (some Encodable)? = Optional<String>.none, timeout: TimeInterval = 30
    ) async throws -> Data {
        var comps = URLComponents(url: baseURL.appendingPathComponent("vault" + path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.percentEncodedQuery = Self.encodeQuery(query) }
        var req = URLRequest(url: comps.url!, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try Self.encoder.encode(body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let error as URLError {
            throw VaultServerError.unreachable(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw VaultServerError.server(status: 0, message: "Not an HTTP response")
        }
        if (200..<300).contains(http.statusCode) { return data }
        throw Self.mapError(status: http.statusCode, data: data)
    }

    /// Percent-encodes every character except RFC 3986 "unreserved" ones.
    /// `URLQueryItem` is NOT enough: it leaves `+` (and `&`, `=`) as they are,
    /// and the server reads a literal `+` as a space — so a Note called
    /// "C++ Basics" was looked up as "C   Basics" (found by the integration
    /// test against the real Vault, not by a unit test).
    static func encodeQuery(_ items: [String: String]) -> String {
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return items.sorted { $0.key < $1.key }.map { key, value in
            let k = key.addingPercentEncoding(withAllowedCharacters: unreserved) ?? key
            let v = value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
            return "\(k)=\(v)"
        }.joined(separator: "&")
    }

    static func mapError(status: Int, data: Data) -> VaultServerError {
        struct Detail: Decodable { var code: String?; var currentSha256: String? }
        struct Envelope: Decodable {
            var detail: Detail?
            var message: String?
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                detail = try? c.decode(Detail.self, forKey: .detail)
                message = try? c.decode(String.self, forKey: .detail)
            }
            enum CodingKeys: String, CodingKey { case detail }
        }
        let env = try? decoder.decode(Envelope.self, from: data)
        switch status {
        case 401: return .unauthorized
        case 404: return .missing
        case 409:
            switch env?.detail?.code {
            case "stale": return .stale(currentSha256: env?.detail?.currentSha256 ?? "")
            case "exists": return .exists(currentSha256: env?.detail?.currentSha256)
            default: return .server(status: 409, message: env?.message ?? "Conflict")
            }
        default:
            return .server(status: status, message: env?.message ?? "HTTP \(status)")
        }
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try Self.decoder.decode(type, from: data) }
        catch { throw VaultServerError.server(status: 200, message: "Unreadable response: \(error)") }
    }

    public func ping() async throws -> Ping {
        try decode(Ping.self, await request("GET", "/ping"))
    }

    public func manifest() async throws -> [ManifestEntry] {
        struct R: Decodable { var notes: [ManifestEntry] }
        return try decode(R.self, await request("GET", "/manifest")).notes
    }

    public func note(path: String) async throws -> RemoteNote {
        try decode(RemoteNote.self, await request("GET", "/note", query: ["path": path]))
    }

    public func put(path: String, content: String, baseSha256: String?) async throws -> PutResult {
        struct B: Encodable { var path: String; var content: String; var baseSha256: String? }
        let body = B(path: path, content: content, baseSha256: baseSha256)
        return try decode(PutResult.self, await request("PUT", "/note", body: body))
    }

    public func delete(path: String, baseSha256: String) async throws {
        _ = try await request("DELETE", "/note", query: ["path": path, "base_sha256": baseSha256])
    }

    public func uploadConflict(path: String, content: String) async throws -> StoredCopy {
        struct B: Encodable { var path: String; var content: String }
        return try decode(StoredCopy.self, await request("POST", "/conflicts", body: B(path: path, content: content)))
    }

    public func listConflicts() async throws -> [StoredCopy] {
        struct R: Decodable { var conflicts: [StoredCopy] }
        return try decode(R.self, await request("GET", "/conflicts")).conflicts
    }

    public func resolveConflict(path: String) async throws {
        _ = try await request("DELETE", "/conflicts", query: ["path": path])
    }

    public func listTrash() async throws -> [StoredCopy] {
        struct R: Decodable { var trash: [StoredCopy] }
        return try decode(R.self, await request("GET", "/trash")).trash
    }

    public func restoreFromTrash(path: String) async throws -> String {
        struct B: Encodable { var path: String }
        struct R: Decodable { var path: String }
        return try decode(R.self, await request("POST", "/trash/restore", body: B(path: path))).path
    }

    public func emptyTrash() async throws -> Int {
        struct R: Decodable { var removed: Int }
        return try decode(R.self, await request("DELETE", "/trash", query: ["confirm": "true"])).removed
    }

    public func search(_ query: String) async throws -> [SearchHit] {
        struct R: Decodable { var hits: [SearchHit] }
        return try decode(R.self, await request("GET", "/search", query: ["q": query], timeout: 20)).hits
    }
}
