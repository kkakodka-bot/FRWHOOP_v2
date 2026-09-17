import Foundation
import GRDB

/// Last-known server-computed HRV/sleep scores for a local day (Phase 4 read cache).
public struct ServerScoreCacheRow: Equatable, Codable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "serverScoreCache"

    public let day: String
    public let algorithmVersion: String
    public let dailyJson: String?
    public let nightsJson: String
    public let computedAt: String?
    public let stale: Bool
    public let fetchedAt: Int

    public init(
        day: String,
        algorithmVersion: String,
        dailyJson: String?,
        nightsJson: String,
        computedAt: String?,
        stale: Bool,
        fetchedAt: Int
    ) {
        self.day = day
        self.algorithmVersion = algorithmVersion
        self.dailyJson = dailyJson
        self.nightsJson = nightsJson
        self.computedAt = computedAt
        self.stale = stale
        self.fetchedAt = fetchedAt
    }

    public enum Columns: String, ColumnExpression {
        case day, algorithmVersion, dailyJson, nightsJson, computedAt, stale, fetchedAt
    }
}

public struct ServerScoreDailyCache: Equatable, Codable {
    public let hrvRmssdMs: Double?
    public let restingHrBpm: Int?
    public let sleepTotalMin: Double?
    public let sleepInBedMin: Double?
    public let sleepAwakeMin: Double?
    public let sleepLightMin: Double?
    public let sleepDeepMin: Double?
    public let sleepRemMin: Double?
    public let sleepEfficiency: Double?
    public let respRateBpm: Double?
    public let computedAt: String?

    public init(
        hrvRmssdMs: Double? = nil,
        restingHrBpm: Int? = nil,
        sleepTotalMin: Double? = nil,
        sleepInBedMin: Double? = nil,
        sleepAwakeMin: Double? = nil,
        sleepLightMin: Double? = nil,
        sleepDeepMin: Double? = nil,
        sleepRemMin: Double? = nil,
        sleepEfficiency: Double? = nil,
        respRateBpm: Double? = nil,
        computedAt: String? = nil
    ) {
        self.hrvRmssdMs = hrvRmssdMs
        self.restingHrBpm = restingHrBpm
        self.sleepTotalMin = sleepTotalMin
        self.sleepInBedMin = sleepInBedMin
        self.sleepAwakeMin = sleepAwakeMin
        self.sleepLightMin = sleepLightMin
        self.sleepDeepMin = sleepDeepMin
        self.sleepRemMin = sleepRemMin
        self.sleepEfficiency = sleepEfficiency
        self.respRateBpm = respRateBpm
        self.computedAt = computedAt
    }
}

public struct ServerScoreNightCache: Equatable, Codable {
    public init(
        id: String,
        startAt: String,
        endAt: String,
        isNap: Bool,
        asleepMin: Double? = nil,
        inBedMin: Double? = nil,
        lightMin: Double? = nil,
        deepMin: Double? = nil,
        remMin: Double? = nil,
        awakeMin: Double? = nil,
        efficiency: Double? = nil,
        hrvRmssdMs: Double? = nil,
        restingHrBpm: Int? = nil
    ) {
        self.id = id
        self.startAt = startAt
        self.endAt = endAt
        self.isNap = isNap
        self.asleepMin = asleepMin
        self.inBedMin = inBedMin
        self.lightMin = lightMin
        self.deepMin = deepMin
        self.remMin = remMin
        self.awakeMin = awakeMin
        self.efficiency = efficiency
        self.hrvRmssdMs = hrvRmssdMs
        self.restingHrBpm = restingHrBpm
    }

    public let id: String
    public let startAt: String
    public let endAt: String
    public let isNap: Bool
    public let asleepMin: Double?
    public let inBedMin: Double?
    public let lightMin: Double?
    public let deepMin: Double?
    public let remMin: Double?
    public let awakeMin: Double?
    public let efficiency: Double?
    public let hrvRmssdMs: Double?
    public let restingHrBpm: Int?
}

public struct ServerScoreDayCache: Equatable {
    public init(
        day: String,
        algorithmVersion: String,
        daily: ServerScoreDailyCache?,
        nights: [ServerScoreNightCache],
        computedAt: String?,
        stale: Bool,
        fetchedAt: Date
    ) {
        self.day = day
        self.algorithmVersion = algorithmVersion
        self.daily = daily
        self.nights = nights
        self.computedAt = computedAt
        self.stale = stale
        self.fetchedAt = fetchedAt
    }

    public let day: String
    public let algorithmVersion: String
    public let daily: ServerScoreDailyCache?
    public let nights: [ServerScoreNightCache]
    public let computedAt: String?
    public let stale: Bool
    public let fetchedAt: Date
}

public enum ServerScoreCacheCodec {
    public static let algorithmVersion = "frwhoop-server-1"

    public static func encodeDaily(_ daily: ServerScoreDailyCache?) -> String? {
        guard let daily else { return nil }
        return String(data: try! JSONEncoder().encode(daily), encoding: .utf8)
    }

    public static func decodeDaily(_ json: String?) -> ServerScoreDailyCache? {
        guard let json, let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(ServerScoreDailyCache.self, from: data)
    }

    public static func encodeNights(_ nights: [ServerScoreNightCache]) -> String {
        let data = (try? JSONEncoder().encode(nights)) ?? Data("[]".utf8)
        return String(data: data, encoding: .utf8) ?? "[]"
    }

    public static func decodeNights(_ json: String) -> [ServerScoreNightCache] {
        guard let data = json.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([ServerScoreNightCache].self, from: data)) ?? []
    }
}

public struct ServerScoreCacheStore {
    private let db: DatabaseWriter

    public init(db: DatabaseWriter) {
        self.db = db
    }

    public func upsert(
        day: String,
        daily: ServerScoreDailyCache?,
        nights: [ServerScoreNightCache],
        computedAt: String?,
        stale: Bool,
        fetchedAt: Int = Int(Date().timeIntervalSince1970)
    ) throws {
        let row = ServerScoreCacheRow(
            day: day,
            algorithmVersion: ServerScoreCacheCodec.algorithmVersion,
            dailyJson: ServerScoreCacheCodec.encodeDaily(daily),
            nightsJson: ServerScoreCacheCodec.encodeNights(nights),
            computedAt: computedAt,
            stale: stale,
            fetchedAt: fetchedAt
        )
        try db.write { db in
            try row.insert(db, onConflict: .replace)
        }
    }

    public func load(day: String) throws -> ServerScoreDayCache? {
        try db.read { db in
            guard let row = try ServerScoreCacheRow.fetchOne(db, key: day) else { return nil }
            return ServerScoreDayCache(
                day: row.day,
                algorithmVersion: row.algorithmVersion,
                daily: ServerScoreCacheCodec.decodeDaily(row.dailyJson),
                nights: ServerScoreCacheCodec.decodeNights(row.nightsJson),
                computedAt: row.computedAt,
                stale: row.stale,
                fetchedAt: Date(timeIntervalSince1970: TimeInterval(row.fetchedAt))
            )
        }
    }
}
