import Foundation
import WhoopStore

/// Fetches `get_day_snapshot` and parses the `server_scoring` overlay.
enum ServerScoreClient {
    enum FetchError: Error {
        case notConfigured
        case unauthorized(accessToken: String)
        case sessionChanged
        case conflict
        case network(Error)
        case decode
    }

    static func fetchDaySnapshot(day: String, ownerId: String) async throws -> ServerScoreDayCache {
        guard let base = ServerScoringSettings.supabaseProjectURL(),
              let anon = ServerScoringSettings.anonKey() else {
            throw FetchError.notConfigured
        }
        let token: String
        if let jwt = try? await CloudAuthClient.validAccessToken() {
            token = jwt
        } else if let ingest = CloudPushSettings.resolvedToken() {
            token = ingest
        } else {
            throw FetchError.notConfigured
        }
        if !ownerId.isEmpty, let jwtOwner = CloudAuthClient.storedSession()?.userId.lowercased(),
           jwtOwner != ownerId.lowercased(), CloudPushSettings.resolvedToken() == nil {
            throw FetchError.sessionChanged
        }
        var request = URLRequest(url: base.appendingPathComponent("functions/v1/scores"))
        request.httpMethod = "GET"
        request.setValue(anon, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false) {
            components.queryItems = [URLQueryItem(name: "day", value: day)]
            request.url = components.url
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw FetchError.decode }
            if http.statusCode == 401 || http.statusCode == 403 { throw FetchError.unauthorized(accessToken: token) }
            guard http.statusCode == 200 else { throw FetchError.decode }
            try Task.checkCancellation()
            let peeked = peekOwnerId(data)
            if let peeked { CloudScoreIdentity.rememberOwner(peeked) }
            let resolvedOwner = !ownerId.isEmpty ? ownerId : (peeked ?? "")
            if let peeked, !ownerId.isEmpty, peeked.lowercased() != ownerId.lowercased(),
               CloudAuthClient.storedSession() != nil {
                throw FetchError.sessionChanged
            }
            return try parseSnapshot(data, day: day, ownerId: resolvedOwner)
        } catch let e as FetchError {
            throw e
        } catch {
            throw FetchError.network(error)
        }
    }

    static func peekOwnerId(_ data: Data) -> String? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let overlay = root["server_scoring"] as? [String: Any],
              let userId = overlay["user_id"] as? String,
              UUID(uuidString: userId) != nil else { return nil }
        return userId.lowercased()
    }

    static func parseSnapshot(_ data: Data, day: String, ownerId: String) throws -> ServerScoreDayCache {
        try ServerScoreCacheCodec.parseSnapshot(data, day: day, ownerId: ownerId)
    }

    static func saveSleepOverride(_ target: ServerSleepEditTarget, start: Int, end: Int, tombstone: Bool) async throws -> Int64 {
        guard let base = ServerScoringSettings.supabaseProjectURL(), let anon = ServerScoringSettings.anonKey() else { throw FetchError.notConfigured }
        let arguments = try target.rpcArguments(start: start, end: end, tombstone: tombstone)
        let token = try await CloudAuthClient.validAccessToken()
        guard CloudAuthClient.storedSession()?.userId.lowercased() == target.ownerId.lowercased() else { throw FetchError.sessionChanged }
        try Task.checkCancellation()
        var request = URLRequest(url: base.appendingPathComponent("rest/v1/rpc/\(target.rpcName)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(anon, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: arguments)
        let (data, response) = try await URLSession.shared.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw FetchError.decode }
        if http.statusCode == 401 || http.statusCode == 403 { throw FetchError.unauthorized(accessToken: token) }
        let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        if http.statusCode == 409 || (object as? [String: Any])?["code"] as? String == "40001" { throw FetchError.conflict }
        guard http.statusCode == 200, let revision = object as? NSNumber, revision.int64Value > target.expectedRevision else { throw FetchError.decode }
        return revision.int64Value
    }
}
