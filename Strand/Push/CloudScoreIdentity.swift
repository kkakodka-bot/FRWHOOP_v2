import Foundation
import WhoopStore

/// Hosted score identity for the owner's fleet: a GoTrue session *or* the baked ingest token.
enum CloudScoreIdentity {
    private static let ownerKey = "noop.serverScoring.ingestOwnerId"
    private static let overlayLiveKey = "noop.serverScoring.overlayLive"

    static func storedOwnerId() -> String? {
        if let jwt = CloudAuthClient.storedSession()?.userId, !jwt.isEmpty { return jwt }
        let ingest = UserDefaults.standard.string(forKey: ownerKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let ingest, UUID(uuidString: ingest) != nil else { return nil }
        return ingest
    }

    static func rememberOwner(_ id: String) {
        let value = id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard UUID(uuidString: value) != nil else { return }
        UserDefaults.standard.set(value, forKey: ownerKey)
    }

    static func clearIngestOwner() {
        UserDefaults.standard.removeObject(forKey: ownerKey)
        markOverlayLive(false)
    }

    static var overlayLive: Bool {
        UserDefaults.standard.bool(forKey: overlayLiveKey)
    }

    static func markOverlayLive(_ live: Bool) {
        UserDefaults.standard.set(live, forKey: overlayLiveKey)
    }

    static func overlayIsLive(_ cache: ServerScoreDayCache) -> Bool {
        guard cache.daily != nil, !cache.stale else { return false }
        return cache.features.values.contains { $0.status == "available" }
    }

    static var hasIngestToken: Bool {
        CloudPushSettings.resolvedToken() != nil
    }
}
