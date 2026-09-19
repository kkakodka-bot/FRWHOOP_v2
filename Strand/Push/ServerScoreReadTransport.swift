import Foundation
import NoopPush

/// One captured-owner read. No shared cookies, cached JWT responses, redirects, or unbounded body.
enum ServerScoreReadTransport {
    static let maximumResponseBytes = 512 * 1024

    static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 25
        configuration.timeoutIntervalForResource = 30
        configuration.waitsForConnectivity = false
        return configuration
    }

    static func read(_ request: URLRequest, context: AccountSessionContext,
                     configuration: URLSessionConfiguration = configuration(),
                     isCurrent: @escaping @Sendable (AccountSessionContext) -> Bool = { CloudAuthClient.isCurrent($0) }) async throws -> Data {
        let expected = URL(string: context.scope.projectURL)?.appendingPathComponent("rest/v1/rpc/get_server_score_snapshot_v2")
        guard request.url == expected, request.httpMethod == "POST" else {
            throw ServerScoreClient.FetchError.invalidResponse
        }
        try Task.checkCancellation()
        guard isCurrent(context) else { throw ServerScoreClient.FetchError.staleSession }
        let session = URLSession(configuration: configuration, delegate: ServerScoreReadRedirectPolicy(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard isCurrent(context) else { throw ServerScoreClient.FetchError.staleSession }
        guard let http = response as? HTTPURLResponse, http.url == expected else {
            throw ServerScoreClient.FetchError.invalidResponse
        }
        if http.statusCode == 401 || http.statusCode == 403 { throw ServerScoreClient.FetchError.unauthorized }
        guard http.statusCode == 200 else { throw ServerScoreClient.FetchError.invalidResponse }
        guard response.expectedContentLength <= Int64(maximumResponseBytes) else { throw ServerScoreDecodeError.tooLarge }
        var data = Data()
        // Count delivered (decompressed) bytes even when Content-Length is absent or misleading.
        for try await byte in bytes {
            guard data.count < maximumResponseBytes else { throw ServerScoreDecodeError.tooLarge }
            data.append(byte)
            if data.count % 16384 == 0 {
                try Task.checkCancellation()
                guard isCurrent(context) else { throw ServerScoreClient.FetchError.staleSession }
            }
        }
        try Task.checkCancellation()
        guard isCurrent(context) else { throw ServerScoreClient.FetchError.staleSession }
        return data
    }
}

final class ServerScoreReadRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
