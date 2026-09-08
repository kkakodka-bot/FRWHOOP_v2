import XCTest
@testable import WhoopStore

/// SHARED cloud-ingestion coverage oracle — the Swift half of the "every table has a destination" guard.
///
/// `Resources/cloud_ingestion_registry.json` pins, for every WhoopStore table, whether it ships to the
/// FRWHOOP cloud fork and names wire stream / delivery / B2 / Supabase targets. The identical file is
/// committed at `android/app/src/test/resources/cloud_ingestion_registry.json`; `CloudIngestionRegistryTest.kt`
/// asserts the same coverage against the shared schema oracle's table list.
final class CloudIngestionRegistryTests: XCTestCase {

    private func loadFixture() throws -> CloudIngestionRegistry.Fixture {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "cloud_ingestion_registry", withExtension: "json"),
                                "missing cloud_ingestion_registry.json test resource")
        return try CloudIngestionRegistry.load(from: Data(contentsOf: url))
    }

    func testEveryGrdbTableHasCloudDestination() async throws {
        let fixture = try loadFixture()
        let live = try await WhoopStore.inMemory().liveSchemaForTest()
        let problems = CloudIngestionRegistry.validate(liveTables: Set(live.keys), fixture: fixture)
        XCTAssertTrue(problems.isEmpty,
                      "cloud ingestion registry drift (\(problems.count)):\n  - "
                      + problems.joined(separator: "\n  - "))
    }

    func testRegistryCopiesAreIdentical() throws {
        let swiftURL = try XCTUnwrap(Bundle.module.url(forResource: "cloud_ingestion_registry", withExtension: "json"))
        let swiftData = try Data(contentsOf: swiftURL)

        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let androidURL = repoRoot.appendingPathComponent("android/app/src/test/resources/cloud_ingestion_registry.json")
        guard FileManager.default.fileExists(atPath: androidURL.path) else {
            throw XCTSkip("android registry copy not present at \(androidURL.path)")
        }
        XCTAssertEqual(swiftData, try Data(contentsOf: androidURL),
                       "cloud_ingestion_registry.json copies differ — keep Swift and Android copies in lockstep")
    }

    func testShippedStreamsAreUnique() throws {
        let fixture = try loadFixture()
        var seen: [String: String] = [:]
        var problems: [String] = []
        for (table, entry) in fixture.tables where entry.classification == .shipped {
            guard let stream = entry.wireStream else { continue }
            if let prior = seen[stream] {
                problems.append("wire stream \(stream) claimed by both \(prior) and \(table)")
            } else {
                seen[stream] = table
            }
        }
        XCTAssertTrue(problems.isEmpty, problems.joined(separator: "\n"))
    }
}
