import Foundation
import WhoopStore

/// Fetches `get_day_snapshot` and parses the `server_scoring` overlay.
enum ServerScoreClient {
    enum FetchError: Error {
        case notConfigured
        case unauthorized
        case network(Error)
        case decode
    }

    static func fetchDaySnapshot(day: String) async throws -> ServerScoreDayCache {
        guard let base = ServerScoringSettings.supabaseProjectURL(),
              let anon = ServerScoringSettings.anonKey() else {
            throw FetchError.notConfigured
        }
        let token = try await CloudAuthClient.validAccessToken()
        var request = URLRequest(url: base.appendingPathComponent("rest/v1/rpc/get_day_snapshot"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(anon, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["p_day": day])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw FetchError.decode }
            if http.statusCode == 401 || http.statusCode == 403 { throw FetchError.unauthorized }
            guard http.statusCode == 200 else { throw FetchError.decode }
            return try parseSnapshot(data, day: day)
        } catch let e as FetchError {
            throw e
        } catch {
            throw FetchError.network(error)
        }
    }

    static func parseSnapshot(_ data: Data, day: String) throws -> ServerScoreDayCache {
        let root = try JSONSerialization.jsonObject(with: data)
        let overlay: [String: Any]
        if let dict = root as? [String: Any] {
            overlay = (dict["server_scoring"] as? [String: Any]) ?? [:]
        } else {
            throw FetchError.decode
        }
        guard (overlay["algorithm_version"] as? String) == ServerScoreCacheCodec.algorithmVersion else {
            return ServerScoreDayCache(
                day: day,
                algorithmVersion: ServerScoreCacheCodec.algorithmVersion,
                daily: nil,
                nights: [],
                computedAt: nil,
                stale: true,
                fetchedAt: Date()
            )
        }
        let dailyObj = overlay["daily"] as? [String: Any]
        let daily: ServerScoreDailyCache? = dailyObj.map { d in
            ServerScoreDailyCache(
                hrvRmssdMs: doubleValue(d["hrv_rmssd_ms"]),
                restingHrBpm: intValue(d["resting_hr_bpm"]),
                sleepTotalMin: doubleValue(d["sleep_total_min"]),
                sleepInBedMin: doubleValue(d["sleep_in_bed_min"]),
                sleepAwakeMin: doubleValue(d["sleep_awake_min"]),
                sleepLightMin: doubleValue(d["sleep_light_min"]),
                sleepDeepMin: doubleValue(d["sleep_deep_min"]),
                sleepRemMin: doubleValue(d["sleep_rem_min"]),
                sleepEfficiency: doubleValue(d["sleep_efficiency"]),
                respRateBpm: doubleValue(d["resp_rate_bpm"]),
                computedAt: d["computed_at"] as? String
            )
        }
        let nightsRaw = (overlay["nights"] as? [[String: Any]]) ?? []
        let nights = nightsRaw.map { n in
            ServerScoreNightCache(
                id: (n["id"] as? String) ?? UUID().uuidString.lowercased(),
                startAt: (n["start_at"] as? String) ?? "",
                endAt: (n["end_at"] as? String) ?? "",
                isNap: (n["is_nap"] as? Bool) ?? false,
                asleepMin: doubleValue(n["asleep_min"]),
                inBedMin: doubleValue(n["in_bed_min"]),
                lightMin: doubleValue(n["light_min"]),
                deepMin: doubleValue(n["deep_min"]),
                remMin: doubleValue(n["rem_min"]),
                awakeMin: doubleValue(n["awake_min"]),
                efficiency: doubleValue(n["efficiency"]),
                hrvRmssdMs: doubleValue(n["hrv_rmssd_ms"]),
                restingHrBpm: intValue(n["resting_hr_bpm"])
            )
        }
        return ServerScoreDayCache(
            day: day,
            algorithmVersion: ServerScoreCacheCodec.algorithmVersion,
            daily: daily,
            nights: nights,
            computedAt: overlay["computed_at"] as? String,
            stale: (overlay["stale"] as? Bool) ?? true,
            fetchedAt: Date()
        )
    }

    private static func doubleValue(_ raw: Any?) -> Double? {
        if let d = raw as? Double { return d }
        if let n = raw as? NSNumber { return n.doubleValue }
        if let s = raw as? String, let d = Double(s) { return d }
        return nil
    }

    private static func intValue(_ raw: Any?) -> Int? {
        if let i = raw as? Int { return i }
        if let n = raw as? NSNumber { return n.intValue }
        if let s = raw as? String, let i = Int(s) { return i }
        if let d = raw as? Double { return Int(d.rounded()) }
        return nil
    }
}
