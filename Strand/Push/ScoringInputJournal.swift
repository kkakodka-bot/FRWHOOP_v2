import Foundation
import CryptoKit
import GRDB
import NoopPush
import WhoopStore

struct ScoringInputChange: Sendable, Equatable {
    enum Kind: String, Codable, Sendable { case profile, config, sleepEdit = "sleep_edit", context, period, importedDaily = "imported_daily", manualWorkout = "manual_workout" }
    let device: String
    let kind: Kind
    let entity: String
    let effectiveDay: String
    let payload: Data
    let deleted: Bool

    init(device: String, kind: Kind, entity: String, effectiveDay: String, payload: Data, deleted: Bool = false) throws {
        guard let uuid = UUID(uuidString: device), !entity.isEmpty, entity.utf8.count <= 128,
              ServerScoreDate.isDay(effectiveDay), effectiveDay >= "1900-01-01", effectiveDay <= "2200-12-31",
              payload.count <= 65536,
              let object = try JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
            throw ScoringInputJournal.Failure.invalidInput
        }
        self.device = uuid.uuidString.lowercased(); self.kind = kind; self.entity = entity
        self.effectiveDay = effectiveDay; self.deleted = deleted
        self.payload = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    var digest: String {
        var data = Data("\(effectiveDay):\(deleted):".utf8); data.append(payload)
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

/// The v3 RPC receipt is useful only for the exact durable mutation that was sent.
struct ScoringInputReceipt: Codable, Sendable, Equatable {
    let schemaVersion: Int
    let userId: UUID
    let sourceDeviceId: UUID
    let kind: ScoringInputChange.Kind
    let entity: String
    let revision: Int64
    let clientId: UUID
    let clientMutationId: UUID
    let clientRevision: Int64
    let effectiveDay: String
    let deleted: Bool
    let invalidatedFrom: String

    func matches(_ pending: ScoringInputJournal.Pending) -> Bool {
        schemaVersion == 1 && userId == UUID(uuidString: pending.scope.userID) &&
        sourceDeviceId == UUID(uuidString: pending.change.device) &&
        kind == pending.change.kind && entity == pending.change.entity &&
        revision > pending.expectedRevision && clientId == pending.clientID &&
        clientMutationId == UUID(uuidString: pending.id) && clientRevision == pending.clientRevision &&
        effectiveDay == pending.change.effectiveDay && deleted == pending.change.deleted &&
        ServerScoreDate.isDay(invalidatedFrom) && invalidatedFrom <= effectiveDay
    }
}

struct ScoringInputHead: Codable, Sendable, Equatable {
    let schemaVersion: Int
    let userId: UUID
    let sourceDeviceId: UUID
    let kind: ScoringInputChange.Kind
    let entity: String
    let headRevision: Int64

    func matches(scope: AccountScope, change: ScoringInputChange) -> Bool {
        schemaVersion == 1 && userId == UUID(uuidString: scope.userID) &&
        sourceDeviceId == UUID(uuidString: change.device) && kind == change.kind &&
        entity == change.entity && headRevision >= 0
    }
}

private final class ScoringInputCommitFence: TransactionObserver {
    let fence: StoreWriteFence
    init(_ fence: StoreWriteFence) { self.fence = fence }
    func observes(eventsOfKind eventKind: DatabaseEventKind) -> Bool { false }
    func databaseDidChange(with event: DatabaseEvent) {}
    func databaseWillCommit() throws {
        do { try fence.check() } catch { throw ScoringInputJournal.Failure.retired }
    }
    func databaseDidCommit(_ db: Database) {}
    func databaseDidRollback(_ db: Database) {}
}

/// A small, independent account journal; it is not part of the physiological GRDB/Room schema.
/// The expected server revision commits BEFORE the request, so a lost response repeats exact input.
actor ScoringInputJournal {
    enum Failure: Error, Equatable { case invalidInput, wrongOwner, retired, storageLimit, invalidReceipt, headRequired, staleReview, held, relayCapacity, retiredOrigin }
    /// Consent's durable AUTOINCREMENT position, not the input journal's client revision.
    /// The high-water mark rejects replay after an acknowledged origin has been compacted.
    struct OriginPosition: Sendable, Equatable {
        let source: UUID
        let sequence: Int64
    }
    struct Pending: Sendable, Equatable {
        let scope: AccountScope
        let clientID: UUID
        let sequence: Int64
        let id: String
        let change: ScoringInputChange
        let expectedRevision: Int64
        let failures: Int
        var clientRevision: Int64 { sequence }
    }
    struct Status: Sendable, Equatable { let pending: Int; let conflicts: Int }
    struct Conflict: Sendable, Equatable {
        let pending: Pending
        let queuedMutationIDs: [String]
        let queuedChanges: [ScoringInputChange]
    }
    enum OriginProgress: Sendable, Equatable {
        case queued(String)
        case accepted(ScoringInputReceipt)
        case resolved(String)
    }
    private let db: DatabaseQueue
    nonisolated let scope: AccountScope
    nonisolated let clientID: UUID
    nonisolated let writeFence: StoreWriteFence
    private var active = true
    private var closed = false

    /// Construct on the storage worker, never a SwiftUI/main-actor initializer.
    init(layout: AccountStorageLayout, fence: StoreWriteFence = StoreWriteFence()) throws {
        guard let scope = layout.scope else { throw Failure.wrongOwner }
        guard fence.isValid else { throw Failure.retired }
        self.scope = scope
        self.writeFence = fence
        try layout.prepare()
        let path = layout.directory.appendingPathComponent("history-inputs.sqlite")
        var configuration = Configuration()
        configuration.busyMode = .timeout(5)
        db = try DatabaseQueue(path: path.path, configuration: configuration)
        db.add(transactionObserver: ScoringInputCommitFence(fence), extent: .databaseLifetime)
        try db.writeWithoutTransaction { database in
            try database.execute(sql: "PRAGMA journal_mode = WAL")
            try database.execute(sql: "PRAGMA synchronous = FULL")
            guard try Int.fetchOne(database, sql: "PRAGMA synchronous") == 2 else { throw Failure.storageLimit }
        }
        clientID = try db.write { database in
            let tables = try String.fetchAll(database, sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            guard tables.isEmpty || tables.contains("input_owner") else { throw Failure.wrongOwner }
            try database.execute(sql: """
                CREATE TABLE IF NOT EXISTS input_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1), project TEXT NOT NULL, user TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS input_head(device TEXT NOT NULL, kind TEXT NOT NULL, entity TEXT NOT NULL,
                    revision INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(device,kind,entity));
                CREATE TABLE IF NOT EXISTS input_change(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                    device TEXT NOT NULL, kind TEXT NOT NULL, entity TEXT NOT NULL, day TEXT NOT NULL,
                    payload BLOB NOT NULL, deleted INTEGER NOT NULL, digest TEXT NOT NULL, expected_revision INTEGER,
                    failures INTEGER NOT NULL DEFAULT 0, retry_at REAL NOT NULL DEFAULT 0, conflict INTEGER NOT NULL DEFAULT 0);
                CREATE INDEX IF NOT EXISTS input_change_entity ON input_change(device,kind,entity,sequence);
                """)
            if let owner = try Row.fetchOne(database, sql: "SELECT project,user FROM input_owner WHERE singleton=1") {
                guard owner["project"] as String == scope.projectURL, owner["user"] as String == scope.userID else { throw Failure.wrongOwner }
            } else {
                guard try Int.fetchOne(database, sql: "SELECT COUNT(*) FROM input_change") == 0,
                      try Int.fetchOne(database, sql: "SELECT COUNT(*) FROM input_head") == 0 else { throw Failure.wrongOwner }
                for table in ["input_origin", "input_resolution", "input_relay", "input_control"] where tables.contains(table) {
                    guard try Int.fetchOne(database, sql: "SELECT COUNT(*) FROM \(table)") == 0 else { throw Failure.wrongOwner }
                }
                try database.execute(sql: "INSERT INTO input_owner(singleton,project,user) VALUES(1,?,?)", arguments: [scope.projectURL, scope.userID])
            }
            // Additive upgrade preserves already-admitted mutation IDs and AUTOINCREMENT revisions.
            if try !database.columns(in: "input_owner").contains(where: { $0.name == "client_id" }) {
                try database.execute(sql: "ALTER TABLE input_owner ADD COLUMN client_id TEXT")
            }
            if try !database.columns(in: "input_head").contains(where: { $0.name == "receipt" }) {
                try database.execute(sql: "ALTER TABLE input_head ADD COLUMN receipt BLOB")
            }
            if try !database.columns(in: "input_head").contains(where: { $0.name == "effective_day" }) {
                try database.execute(sql: "ALTER TABLE input_head ADD COLUMN effective_day TEXT")
            }
            try database.execute(sql: """
                CREATE TABLE IF NOT EXISTS input_resolution(
                    id TEXT PRIMARY KEY, original_sequence INTEGER NOT NULL,
                    device TEXT NOT NULL,kind TEXT NOT NULL,entity TEXT NOT NULL,day TEXT NOT NULL,
                    payload BLOB NOT NULL,deleted INTEGER NOT NULL,digest TEXT NOT NULL,expected_revision INTEGER,
                    replacement_id TEXT NOT NULL,reviewed_head INTEGER NOT NULL,settled_revision INTEGER);
                CREATE INDEX IF NOT EXISTS input_resolution_entity ON input_resolution(device,kind,entity);
                CREATE TABLE IF NOT EXISTS input_origin(
                    origin_id TEXT PRIMARY KEY,mutation_id TEXT NOT NULL UNIQUE,
                    device TEXT NOT NULL,kind TEXT NOT NULL,entity TEXT NOT NULL,day TEXT NOT NULL,
                    digest TEXT NOT NULL,receipt BLOB);
                CREATE TABLE IF NOT EXISTS input_relay(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    source TEXT NOT NULL,last_sequence INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS input_control(
                    purpose TEXT PRIMARY KEY NOT NULL CHECK(purpose IN('journal_context','cycle_context','imported_metrics','manual_workouts')),
                    origin_id TEXT NOT NULL UNIQUE);
                """)
            if try !database.columns(in: "input_origin").contains(where: { $0.name == "source_sequence" }) {
                try database.execute(sql: "ALTER TABLE input_origin ADD COLUMN source_sequence INTEGER")
            }
            if let saved = try String.fetchOne(database, sql: "SELECT client_id FROM input_owner WHERE singleton=1") {
                guard let id = UUID(uuidString: saved) else { throw Failure.invalidInput }
                return id
            }
            let id = UUID()
            try database.execute(sql: "UPDATE input_owner SET client_id=? WHERE singleton=1", arguments: [id.uuidString.lowercased()])
            return id
        }
        #if os(iOS)
        for suffix in ["", "-wal", "-shm"] where FileManager.default.fileExists(atPath: path.path + suffix) {
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                                  ofItemAtPath: path.path + suffix)
        }
        #endif
    }

    func retire() { writeFence.invalidate(); active = false }

    func close() throws {
        retire()
        guard !closed else { return }
        try db.close()
        closed = true
    }

    /// The durable origin is committed with its mutation. Retrying a cross-journal relay cannot
    /// append an older configuration after a newer one, even after the original mutation settled.
    func importOrigin(_ origin: UUID, change: ScoringInputChange, position: OriginPosition,
                      denialPurpose: ScoringContextPurpose? = nil,
                      beforeCommit: (@Sendable () -> Void)? = nil) throws -> OriginProgress {
        guard active, writeFence.isValid else { throw Failure.retired }
        guard change.kind == .config, !change.deleted, position.sequence > 0 else { throw Failure.invalidInput }
        let id = origin.uuidString.lowercased()
        return try db.write { database in
            let highWater = try relayPosition(position, database: database)
            if let saved = try Row.fetchOne(database, sql: "SELECT * FROM input_origin WHERE origin_id=?", arguments: [id]) {
                guard saved["device"] as String == change.device, saved["kind"] as String == change.kind.rawValue,
                      saved["entity"] as String == change.entity, saved["day"] as String == change.effectiveDay,
                      saved["digest"] as String == change.digest,
                      (saved["source_sequence"] as Int64?).map({ $0 == position.sequence }) ?? true else { throw Failure.invalidInput }
                // Bind pre-upgrade origins in place, including receipts lost at the cross-DB boundary.
                try database.execute(sql: "UPDATE input_origin SET source_sequence=? WHERE origin_id=?", arguments: [position.sequence, id])
                try advanceRelay(position, database: database)
                return try originProgress(saved, database: database)
            }
            guard position.sequence > highWater else { throw Failure.retiredOrigin }
            let originCount = try Int.fetchOne(database, sql: """
                SELECT COUNT(*) FROM input_origin o
                WHERE NOT EXISTS(SELECT 1 FROM input_control c WHERE c.origin_id=o.origin_id)
                """) ?? 0
            let ordinary = try ordinaryPendingFits(change.payload.count, database: database) && originCount < 4096
            if !ordinary {
                // Only a persisted denial's typed purpose can use the bounded control reserve.
                // Never reclassify old debt, overwrite another denial, or let an ordinary config
                // consume it. Bound canonical bytes as JSON escaping can expand the input.
                guard let denialPurpose, change.entity == "primary", change.payload.count <= 65536,
                      try Int.fetchOne(database, sql: "SELECT COUNT(*) FROM input_control WHERE purpose=?",
                        arguments: [denialPurpose.rawValue]) == 0 else { throw Failure.storageLimit }
                try database.execute(sql: "INSERT INTO input_control(purpose,origin_id) VALUES(?,?)",
                    arguments: [denialPurpose.rawValue, id])
            }
            try database.execute(sql: """
                INSERT INTO input_change(id,device,kind,entity,day,payload,deleted,digest) VALUES(?,?,?,?,?,?,?,?);
                """, arguments: [id, change.device, change.kind.rawValue, change.entity, change.effectiveDay,
                                  change.payload, change.deleted, change.digest])
            try database.execute(sql: "INSERT INTO input_origin(origin_id,mutation_id,device,kind,entity,day,digest,source_sequence) VALUES(?,?,?,?,?,?,?,?)",
                arguments: [id, id, change.device, change.kind.rawValue, change.entity, change.effectiveDay, change.digest, position.sequence])
            try advanceRelay(position, database: database)
            beforeCommit?()
            return .queued(id)
        }
    }

    private func relayPosition(_ position: OriginPosition, database: Database) throws -> Int64 {
        if let row = try Row.fetchOne(database, sql: "SELECT source,last_sequence FROM input_relay WHERE singleton=1") {
            guard row["source"] as String == position.source.uuidString.lowercased() else { throw Failure.wrongOwner }
            return row["last_sequence"]
        }
        try database.execute(sql: "INSERT INTO input_relay VALUES(1,?,0)", arguments: [position.source.uuidString.lowercased()])
        return 0
    }

    private func advanceRelay(_ position: OriginPosition, database: Database) throws {
        try database.execute(sql: "UPDATE input_relay SET last_sequence=MAX(last_sequence,?) WHERE singleton=1", arguments: [position.sequence])
    }

    /// Only after consent has durably copied the exact accepted receipt. The input high-water
    /// mark and origin deletion commit together; a crash before consent deletion is replay-safe.
    func retireOrigin(_ origin: UUID, change: ScoringInputChange, position: OriginPosition,
                      receipt: ScoringInputReceipt, beforeCommit: (@Sendable () -> Void)? = nil) throws {
        guard active, writeFence.isValid else { throw Failure.retired }
        guard position.sequence > 0 else { throw Failure.invalidInput }
        let id = origin.uuidString.lowercased()
        try db.write { database in
            let highWater = try relayPosition(position, database: database)
            if let row = try Row.fetchOne(database, sql: "SELECT * FROM input_origin WHERE origin_id=?", arguments: [id]) {
                guard row["digest"] as String == change.digest,
                      row["device"] as String == change.device, row["kind"] as String == change.kind.rawValue,
                      row["entity"] as String == change.entity, row["day"] as String == change.effectiveDay,
                      (row["source_sequence"] as Int64?).map({ $0 == position.sequence }) ?? true,
                      try originProgress(row, database: database) == .accepted(receipt),
                      try Int.fetchOne(database, sql: "SELECT COUNT(*) FROM input_change WHERE id=?", arguments: [id]) == 0 else {
                    throw Failure.invalidReceipt
                }
                try advanceRelay(position, database: database)
                try database.execute(sql: "DELETE FROM input_origin WHERE origin_id=?", arguments: [id])
                // Receipt copying precedes this transaction. Settlement alone cannot release a
                // slot: the exact accepted origin must survive a crash until this handshake.
                try database.execute(sql: "DELETE FROM input_control WHERE origin_id=?", arguments: [id])
            } else {
                guard position.sequence <= highWater else { throw Failure.invalidReceipt }
            }
            beforeCommit?()
        }
    }

    func originProgress(_ origin: UUID) throws -> OriginProgress? {
        guard active, writeFence.isValid else { throw Failure.retired }
        return try db.read { database in
            guard let row = try Row.fetchOne(database, sql: "SELECT * FROM input_origin WHERE origin_id=?",
                arguments: [origin.uuidString.lowercased()]) else { return nil }
            return try originProgress(row, database: database)
        }
    }

    private func originProgress(_ row: Row, database: Database) throws -> OriginProgress {
        let id: String = row["mutation_id"]
        if let data: Data = row["receipt"] {
            let receipt = try JSONDecoder().decode(ScoringInputReceipt.self, from: data)
            guard receipt.userId == UUID(uuidString: scope.userID), receipt.clientId == clientID,
                  receipt.clientMutationId == UUID(uuidString: id), receipt.kind.rawValue == (row["kind"] as String),
                  receipt.sourceDeviceId == UUID(uuidString: row["device"]), receipt.entity == (row["entity"] as String),
                  receipt.effectiveDay == (row["day"] as String) else { throw Failure.invalidReceipt }
            return .accepted(receipt)
        }
        if let replacement = try String.fetchOne(database, sql: "SELECT replacement_id FROM input_resolution WHERE id=?", arguments: [id]) {
            return .resolved(replacement)
        }
        guard try Bool.fetchOne(database, sql: "SELECT EXISTS(SELECT 1 FROM input_change WHERE id=?)", arguments: [id]) == true else {
            throw Failure.invalidReceipt
        }
        return .queued(id)
    }

    @discardableResult
    func enqueue(_ input: ScoringInputChange,
                 allowing: @Sendable (ScoringInputChange) -> Bool = { _ in true },
                 beforeCommit: (@Sendable () -> Void)? = nil) throws -> String? {
        guard active, writeFence.isValid else { throw Failure.retired }
        return try db.write { database in
            try Task.checkCancellation()
            guard allowing(input) else { throw Failure.held }
            let change = try preservingSleepDay(input, database: database)
            let key: StatementArguments = [change.device, change.kind.rawValue, change.entity]
            if let last = try Row.fetchOne(database, sql: "SELECT id,digest FROM input_change WHERE device=? AND kind=? AND entity=? ORDER BY sequence DESC LIMIT 1", arguments: key) {
                if last["digest"] as String == change.digest { return last["id"] as String }
            } else if try String.fetchOne(database, sql: "SELECT digest FROM input_head WHERE device=? AND kind=? AND entity=?", arguments: key) == change.digest {
                return nil
            }
            // Refuse new admission instead of deleting an older pending edit to satisfy a cap.
            guard try ordinaryPendingFits(change.payload.count, database: database) else { throw Failure.storageLimit }
            let id = UUID().uuidString.lowercased()
            guard allowing(change) else { throw Failure.held }
            try database.execute(sql: """
                INSERT INTO input_change(id,device,kind,entity,day,payload,deleted,digest) VALUES(?,?,?,?,?,?,?,?)
                """, arguments: [id, change.device, change.kind.rawValue, change.entity, change.effectiveDay,
                                  change.payload, change.deleted, change.digest])
            beforeCommit?()
            try Task.checkCancellation()
            return id
        }
    }

    /// The four immutable overflow denials have their own count and payload budget. Keeping
    /// their allocation through origin retirement also bounds accepted/resolved control debt.
    private func ordinaryPendingFits(_ additionalBytes: Int, database: Database) throws -> Bool {
        let usage = try Row.fetchOne(database, sql: """
            SELECT COUNT(*) AS count,COALESCE(SUM(length(payload)),0) AS bytes FROM input_change p
            WHERE NOT EXISTS(SELECT 1 FROM input_control c WHERE c.origin_id=p.id)
            """)!
        return (usage["count"] as Int) < 4096 && (usage["bytes"] as Int) + additionalBytes <= 16 * 1_048_576
    }

    private func preservingSleepDay(_ change: ScoringInputChange, database: Database) throws -> ScoringInputChange {
        guard change.kind == .sleepEdit else { return change }
        let key: [String] = [change.device, change.kind.rawValue, change.entity]
        let earliest = try String.fetchOne(database, sql: """
            SELECT MIN(day) FROM (
              SELECT day FROM input_change WHERE device=? AND kind=? AND entity=?
              UNION ALL SELECT effective_day AS day FROM input_head WHERE device=? AND kind=? AND entity=?
              UNION ALL SELECT day FROM input_resolution WHERE device=? AND kind=? AND entity=?)
            """, arguments: StatementArguments(key + key + key))
        guard let earliest, earliest < change.effectiveDay else { return change }
        return try ScoringInputChange(device: change.device, kind: change.kind, entity: change.entity,
            effectiveDay: earliest, payload: change.payload, deleted: change.deleted)
    }

    private func readyRow(_ database: Database, now: Date,
                          allowing: @Sendable (ScoringInputChange) -> Bool) throws -> Row? {
        let cursor = try Row.fetchCursor(database, sql: """
            SELECT c.* FROM input_change c WHERE c.conflict=0 AND c.retry_at<=?
              AND NOT EXISTS(SELECT 1 FROM input_change prior WHERE prior.device=c.device
                AND prior.kind=c.kind AND prior.entity=c.entity AND prior.sequence<c.sequence)
            ORDER BY c.sequence
            """, arguments: [now.timeIntervalSince1970])
        while let row = try cursor.next() {
            if try allowing(pending(row, expected: 0).change) { return row.copy() }
        }
        return nil
    }

    private func pending(_ row: Row, expected: Int64) throws -> Pending {
        guard let kind = ScoringInputChange.Kind(rawValue: row["kind"]) else { throw Failure.invalidInput }
        return Pending(scope: scope, clientID: clientID, sequence: row["sequence"], id: row["id"],
            change: try ScoringInputChange(device: row["device"], kind: kind, entity: row["entity"],
                effectiveDay: row["day"], payload: row["payload"], deleted: row["deleted"]),
            expectedRevision: expected, failures: row["failures"])
    }

    /// Metadata lookup never mutates an already-frozen request, including pre-upgrade debt.
    func initialHeadRequest(now: Date = Date(), allowing: @Sendable (ScoringInputChange) -> Bool = { _ in true }) throws -> Pending? {
        guard active, writeFence.isValid else { throw Failure.retired }
        return try db.read { database in
            guard let row = try readyRow(database, now: now, allowing: allowing), row["expected_revision"] as Int64? == nil,
                  try Int64.fetchOne(database, sql: "SELECT revision FROM input_head WHERE device=? AND kind=? AND entity=?",
                    arguments: [row["device"] as String, row["kind"] as String, row["entity"] as String]) == nil else { return nil }
            return try pending(row, expected: 0)
        }
    }

    func freezeInitialHead(_ head: ScoringInputHead, for request: Pending,
                           allowing: @Sendable (ScoringInputChange) -> Bool = { _ in true }) throws {
        guard active, writeFence.isValid else { throw Failure.retired }
        guard request.scope == scope, request.clientID == clientID, head.matches(scope: scope, change: request.change) else {
            throw Failure.invalidReceipt
        }
        try db.write { database in
            guard allowing(request.change) else { return }
            guard let row = try Row.fetchOne(database, sql: "SELECT * FROM input_change WHERE sequence=? AND id=?",
                arguments: [request.sequence, request.id]), try pending(row, expected: 0).change == request.change else { throw Failure.staleReview }
            // Another opener may have frozen or settled work while metadata was in flight.
            // Never replace that expected revision with a newly fetched one.
            guard row["expected_revision"] as Int64? == nil else { return }
            try database.execute(sql: "UPDATE input_change SET expected_revision=? WHERE sequence=? AND expected_revision IS NULL",
                arguments: [head.headRevision, request.sequence])
        }
    }

    /// requireKnownHead is used by the network coordinator. Direct callers with a known empty
    /// fixture/legacy head retain the existing zero-head journal API.
    func next(now: Date = Date(), requireKnownHead: Bool = false,
              allowing: @Sendable (ScoringInputChange) -> Bool = { _ in true }) throws -> Pending? {
        guard active, writeFence.isValid else { throw Failure.retired }
        return try db.write { database in
            // A conflict blocks only its entity; unrelated profile/config/edits may progress.
            guard let row = try readyRow(database, now: now, allowing: allowing) else { return nil }
            let sequence: Int64 = row["sequence"]
            let expected = try (row["expected_revision"] as Int64?) ?? (Int64.fetchOne(database,
                sql: "SELECT revision FROM input_head WHERE device=? AND kind=? AND entity=?",
                arguments: [row["device"] as String, row["kind"] as String, row["entity"] as String]))
            guard expected != nil || !requireKnownHead else { throw Failure.headRequired }
            try database.execute(sql: "UPDATE input_change SET expected_revision=? WHERE sequence=?", arguments: [expected ?? 0, sequence])
            return try pending(row, expected: expected ?? 0)
        }
    }

    func settle(_ pending: Pending, receipt: ScoringInputReceipt, beforeCommit: (@Sendable () -> Void)? = nil) throws {
        guard active, writeFence.isValid else { throw Failure.retired }
        guard pending.scope == scope, pending.clientID == clientID, receipt.matches(pending) else { throw Failure.invalidReceipt }
        try db.write { database in
            guard let row = try Row.fetchOne(database, sql: "SELECT * FROM input_change WHERE sequence=?", arguments: [pending.sequence]),
                  row["id"] as String == pending.id, row["expected_revision"] as Int64 == pending.expectedRevision,
                  row["digest"] as String == pending.change.digest,
                  row["device"] as String == pending.change.device, row["kind"] as String == pending.change.kind.rawValue,
                  row["entity"] as String == pending.change.entity, row["day"] as String == pending.change.effectiveDay,
                  row["payload"] as Data == pending.change.payload, row["deleted"] as Bool == pending.change.deleted
            else { throw Failure.invalidReceipt }
            let known = try Int64.fetchOne(database, sql: "SELECT revision FROM input_head WHERE device=? AND kind=? AND entity=?",
                arguments: [pending.change.device, pending.change.kind.rawValue, pending.change.entity]) ?? 0
            guard receipt.revision >= known else { throw Failure.invalidReceipt }
            try database.execute(sql: """
                INSERT INTO input_head(device,kind,entity,revision,digest,receipt,effective_day) VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(device,kind,entity) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,receipt=excluded.receipt,
                  effective_day=CASE WHEN excluded.kind='sleep_edit' THEN MIN(COALESCE(input_head.effective_day,excluded.effective_day),excluded.effective_day)
                                     ELSE excluded.effective_day END
                """, arguments: [pending.change.device, pending.change.kind.rawValue, pending.change.entity,
                                   receipt.revision, pending.change.digest, try JSONEncoder().encode(receipt), pending.change.effectiveDay])
            try database.execute(sql: "UPDATE input_resolution SET settled_revision=? WHERE replacement_id=?",
                arguments: [receipt.revision, pending.id])
            try database.execute(sql: "UPDATE input_origin SET receipt=? WHERE mutation_id=?",
                arguments: [try JSONEncoder().encode(receipt), pending.id])
            try database.execute(sql: "DELETE FROM input_change WHERE sequence=?", arguments: [pending.sequence])
            beforeCommit?()
        }
    }

    func retry(_ pending: Pending, conflict: Bool, now: Date = Date()) throws {
        guard active, writeFence.isValid else { throw Failure.retired }
        guard pending.scope == scope, pending.clientID == clientID else { throw Failure.wrongOwner }
        let delay = min(300.0, pow(2, Double(min(8, pending.failures))))
        try db.write { database in
            try database.execute(sql: "UPDATE input_change SET failures=failures+1,retry_at=?,conflict=? WHERE sequence=? AND id=?",
                arguments: [now.timeIntervalSince1970 + delay, conflict, pending.sequence, pending.id])
        }
    }

    func status() throws -> Status {
        try db.read { database in
            Status(pending: try Int.fetchOne(database, sql: "SELECT COUNT(*) FROM input_change") ?? 0,
                   conflicts: try Int.fetchOne(database, sql: "SELECT COUNT(*) FROM input_change WHERE conflict=1") ?? 0)
        }
    }

    func conflict(id: String) throws -> Conflict? {
        guard active, writeFence.isValid else { throw Failure.retired }
        return try db.read { database in try conflict(id: id, database: database) }
    }

    func conflicts(limit: Int = 32) throws -> [Conflict] {
        guard active, writeFence.isValid else { throw Failure.retired }
        return try db.read { database in
            let ids = try String.fetchAll(database, sql: "SELECT id FROM input_change WHERE conflict=1 ORDER BY sequence LIMIT ?",
                arguments: [max(1, min(128, limit))])
            return try ids.compactMap { try conflict(id: $0, database: database) }
        }
    }

    private func conflict(id: String, database: Database) throws -> Conflict? {
        guard let row = try Row.fetchOne(database, sql: "SELECT * FROM input_change WHERE id=? AND conflict=1", arguments: [id]),
              let expected = row["expected_revision"] as Int64? else { return nil }
        let first = try pending(row, expected: expected)
        let queued = try Row.fetchAll(database, sql: "SELECT * FROM input_change WHERE device=? AND kind=? AND entity=? ORDER BY sequence",
            arguments: [first.change.device, first.change.kind.rawValue, first.change.entity])
        guard queued.first?["id"] as String? == id else { return nil }
        return Conflict(pending: first, queuedMutationIDs: queued.map { $0["id"] },
            queuedChanges: try queued.map { try pending($0, expected: ($0["expected_revision"] as Int64?) ?? 0).change })
    }

    /// Explicitly replace the entire reviewed entity queue, never just its first row: otherwise
    /// pre-existing followers would carry lower client revisions than the rebased mutation.
    /// Original intents remain in the owner-bound resolution archive; no reconciliation calls this.
    @discardableResult
    func resolveConflict(_ review: Conflict, head: ScoringInputHead, replacement: ScoringInputChange,
                         allowing: @Sendable (ScoringInputChange) -> Bool = { _ in true }) throws -> String {
        guard active, writeFence.isValid else { throw Failure.retired }
        guard review.pending.scope == scope, review.pending.clientID == clientID,
              head.matches(scope: scope, change: review.pending.change), head.headRevision >= review.pending.expectedRevision,
              replacement.device == review.pending.change.device, replacement.kind == review.pending.change.kind,
              replacement.entity == review.pending.change.entity else { throw Failure.invalidReceipt }
        return try db.write { database in
            guard allowing(replacement) else { throw Failure.held }
            guard try conflict(id: review.pending.id, database: database) == review else { throw Failure.staleReview }
            let replacement = try preservingSleepDay(replacement, database: database)
            let archiveCount = try Int.fetchOne(database, sql: "SELECT COUNT(*) FROM input_resolution") ?? 0
            guard archiveCount + review.queuedMutationIDs.count <= 4096 else { throw Failure.storageLimit }
            let key: StatementArguments = [replacement.device, replacement.kind.rawValue, replacement.entity]
            let id = UUID().uuidString.lowercased()
            guard allowing(replacement) else { throw Failure.held }
            try database.execute(sql: """
                INSERT INTO input_resolution(id,original_sequence,device,kind,entity,day,payload,deleted,digest,expected_revision,replacement_id,reviewed_head)
                SELECT id,sequence,device,kind,entity,day,payload,deleted,digest,expected_revision,?,?
                  FROM input_change WHERE device=? AND kind=? AND entity=?
                """, arguments: [id, head.headRevision, replacement.device, replacement.kind.rawValue, replacement.entity])
            try database.execute(sql: "DELETE FROM input_change WHERE device=? AND kind=? AND entity=?", arguments: key)
            // An explicit replacement is ordinary admission, not a new control reservation.
            // Failure rolls back both the archive and deletion; reviewed debt remains intact.
            guard try ordinaryPendingFits(replacement.payload.count, database: database) else { throw Failure.storageLimit }
            try database.execute(sql: """
                INSERT INTO input_change(id,device,kind,entity,day,payload,deleted,digest,expected_revision) VALUES(?,?,?,?,?,?,?,?,?)
                """, arguments: [id, replacement.device, replacement.kind.rawValue, replacement.entity, replacement.effectiveDay,
                                  replacement.payload, replacement.deleted, replacement.digest, head.headRevision])
            return id
        }
    }
}
