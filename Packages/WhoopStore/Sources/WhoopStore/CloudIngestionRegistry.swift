import Foundation

/// Declares where every `WhoopStore` table ships in the FRWHOOP cloud fork, or why it stays local.
/// Loaded from the shared `cloud_ingestion_registry.json` oracle (byte-identical Swift/Android copy).
public enum CloudIngestionRegistry {
    public enum Classification: String, Decodable, Sendable {
        case shipped
        case localOnly = "local_only"
    }

    public enum Delivery: String, Decodable, Sendable {
        case append
        case replaceWindow = "replace_window"
        case binaryObject = "binary_object"
    }

    public struct TableEntry: Decodable, Sendable {
        public let platform: String
        public let classification: Classification
        public let wireStream: String?
        public let delivery: Delivery?
        public let b2Stream: String?
        public let b2Extension: String?
        public let b2RetentionClass: String?
        public let supabaseTable: String?
        public let why: String
    }

    public struct Fixture: Decodable, Sendable {
        public let registryVersion: Int
        public let tables: [String: TableEntry]
    }

    public static func load(from data: Data) throws -> Fixture {
        try JSONDecoder().decode(Fixture.self, from: data)
    }

    /// Validates that `liveTables` and the fixture agree: every live table is declared, shipped rows
    /// name every required destination field, and local-only rows carry a non-empty reason.
    public static func validate(liveTables: Set<String>, fixture: Fixture) -> [String] {
        var problems: [String] = []

        for table in liveTables.sorted() {
            guard let entry = fixture.tables[table] else {
                problems.append("\(table): live WhoopStore table missing from cloud_ingestion_registry.json")
                continue
            }
            if entry.why.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                problems.append("\(table): `why` must be non-empty")
            }
            switch entry.classification {
            case .shipped:
                if entry.wireStream == nil { problems.append("\(table): shipped row missing wireStream") }
                if entry.delivery == nil { problems.append("\(table): shipped row missing delivery") }
                if entry.b2Stream == nil { problems.append("\(table): shipped row missing b2Stream") }
                if entry.b2Extension == nil { problems.append("\(table): shipped row missing b2Extension") }
                if entry.b2RetentionClass == nil { problems.append("\(table): shipped row missing b2RetentionClass") }
                if entry.supabaseTable == nil { problems.append("\(table): shipped row missing supabaseTable") }
            case .localOnly:
                if entry.wireStream != nil || entry.delivery != nil || entry.b2Stream != nil
                    || entry.b2Extension != nil || entry.b2RetentionClass != nil || entry.supabaseTable != nil {
                    problems.append("\(table): local_only row must not name cloud destinations")
                }
            }
        }

        let extra = Set(fixture.tables.keys).subtracting(liveTables).sorted()
        for table in extra {
            let entry = fixture.tables[table]!
            if entry.platform == "android_only" || entry.platform == "both_file" { continue }
            problems.append("\(table): declared in cloud_ingestion_registry.json but not created by GRDB migrator")
        }

        return problems
    }
}
