import Foundation
import CryptoKit
import NoopPush

/// Encrypted-durable progress scoped to one endpoint/protocol/receiver namespace.
struct CloudPushProgressStore: PushProgressStore {
    private let namespace: String
    private let defaults = UserDefaults.standard

    init(namespace: String) {
        self.namespace = namespace
    }

    func knownDeviceIds() async throws -> Set<String> {
        Set(defaults.stringArray(forKey: devicesKey) ?? [])
    }

    func rememberDeviceId(_ deviceId: String) async throws {
        var ids = try await knownDeviceIds()
        ids.insert(deviceId)
        defaults.set(Array(ids), forKey: devicesKey)
    }

    func cursor(table: PushAppendTable, deviceId: String) async throws -> PushCursor? {
        let prefix = scopedKey("append", table.wireName, deviceId)
        let rowId = defaults.object(forKey: "\(prefix).row") as? Int64
            ?? Int64(defaults.integer(forKey: "\(prefix).row"))
        let fingerprint = defaults.string(forKey: "\(prefix).key")
        guard rowId > 0, let fingerprint else { return nil }
        return PushCursor(rowId: rowId, naturalKeyFingerprint: fingerprint)
    }

    func saveCursor(table: PushAppendTable, deviceId: String, cursor: PushCursor) async throws {
        let prefix = scopedKey("append", table.wireName, deviceId)
        defaults.set(cursor.rowId, forKey: "\(prefix).row")
        defaults.set(cursor.naturalKeyFingerprint, forKey: "\(prefix).key")
    }

    func binaryCursor(table: PushBinaryTable, deviceId: String) async throws -> PushCursor? {
        let prefix = scopedKey("binary", table.wireName, deviceId)
        let rowId = defaults.object(forKey: "\(prefix).row") as? Int64
            ?? Int64(defaults.integer(forKey: "\(prefix).row"))
        let fingerprint = defaults.string(forKey: "\(prefix).key")
        guard rowId > 0, let fingerprint else { return nil }
        return PushCursor(rowId: rowId, naturalKeyFingerprint: fingerprint)
    }

    func saveBinaryCursor(table: PushBinaryTable, deviceId: String, cursor: PushCursor) async throws {
        let prefix = scopedKey("binary", table.wireName, deviceId)
        defaults.set(cursor.rowId, forKey: "\(prefix).row")
        defaults.set(cursor.naturalKeyFingerprint, forKey: "\(prefix).key")
    }

    func window(table: PushMutableTable, deviceId: String) async throws -> PushWindowProgress? {
        let prefix = scopedKey("mutable", table.wireName, deviceId)
        guard let batchId = defaults.string(forKey: "\(prefix).batchId") else { return nil }
        let fromDay = defaults.string(forKey: "\(prefix).fromDay") ?? ""
        let toDay = defaults.string(forKey: "\(prefix).toDay") ?? ""
        let startTs = defaults.object(forKey: "\(prefix).startTs") as? Int64
            ?? Int64(defaults.integer(forKey: "\(prefix).startTs"))
        let endTs = defaults.object(forKey: "\(prefix).endTs") as? Int64
            ?? Int64(defaults.integer(forKey: "\(prefix).endTs"))
        let window = PushWindow(
            fromDay: fromDay,
            toDay: toDay,
            startTsInclusive: startTs,
            endTsExclusive: endTs
        )
        let dayHashes = (defaults.dictionary(forKey: "\(prefix).dayHashes") as? [String: String]) ?? [:]
        return PushWindowProgress(window: window, batchId: batchId, dayHashes: dayHashes)
    }

    func saveWindow(table: PushMutableTable, deviceId: String, progress: PushWindowProgress) async throws {
        let prefix = scopedKey("mutable", table.wireName, deviceId)
        defaults.set(progress.batchId, forKey: "\(prefix).batchId")
        defaults.set(progress.window.fromDay, forKey: "\(prefix).fromDay")
        defaults.set(progress.window.toDay, forKey: "\(prefix).toDay")
        defaults.set(progress.window.startTsInclusive, forKey: "\(prefix).startTs")
        defaults.set(progress.window.endTsExclusive, forKey: "\(prefix).endTs")
        defaults.set(progress.dayHashes, forKey: "\(prefix).dayHashes")
    }

    func inFlightObject(table: PushBinaryTable, deviceId: String) async throws -> PushInFlightObject? {
        let prefix = scopedKey("inflight", table.wireName, deviceId)
        guard let objectId = defaults.string(forKey: "\(prefix).objectId"),
              let objectKey = defaults.string(forKey: "\(prefix).objectKey"),
              let sha = defaults.string(forKey: "\(prefix).sha") else { return nil }
        return PushInFlightObject(
            objectId: objectId,
            objectKey: objectKey,
            contentSha256: sha,
            uploaded: defaults.bool(forKey: "\(prefix).uploaded")
        )
    }

    func saveInFlightObject(table: PushBinaryTable, deviceId: String, object: PushInFlightObject?) async throws {
        let prefix = scopedKey("inflight", table.wireName, deviceId)
        if let object {
            defaults.set(object.objectId, forKey: "\(prefix).objectId")
            defaults.set(object.objectKey, forKey: "\(prefix).objectKey")
            defaults.set(object.contentSha256, forKey: "\(prefix).sha")
            defaults.set(object.uploaded, forKey: "\(prefix).uploaded")
        } else {
            defaults.removeObject(forKey: "\(prefix).objectId")
            defaults.removeObject(forKey: "\(prefix).objectKey")
            defaults.removeObject(forKey: "\(prefix).sha")
            defaults.removeObject(forKey: "\(prefix).uploaded")
        }
    }

    private var devicesKey: String { "cloudPush.\(namespace).devices" }

    private func scopedKey(_ kind: String, _ table: String, _ deviceId: String) -> String {
        let digest = SHA256.hash(data: Data(deviceId.utf8))
        let hash = digest.map { String(format: "%02x", $0) }.joined()
        return "cloudPush.\(namespace).\(kind).\(table).\(hash)"
    }
}
