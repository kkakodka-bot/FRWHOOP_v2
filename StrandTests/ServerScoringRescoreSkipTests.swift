import XCTest
@testable import Strand

/// Remaining 3: when `serverScoring` is on, sync-coupled rescore drains must not invoke analyzeRecent.
@MainActor
final class ServerScoringRescoreSkipTests: XCTestCase {

    private var savedServerScoring: Any?
    private var savedOwed: Any?
    private var savedToken: Any?

    override func setUp() {
        super.setUp()
        savedServerScoring = UserDefaults.standard.object(forKey: ServerScoringSettings.defaultsKey)
        savedOwed = UserDefaults.standard.object(forKey: RescoreBackgroundScheduler.owedKey)
        savedToken = UserDefaults.standard.object(forKey: RescoreBackgroundScheduler.owedTokenKey)
        UserDefaults.standard.removeObject(forKey: ServerScoringSettings.defaultsKey)
        UserDefaults.standard.removeObject(forKey: RescoreBackgroundScheduler.owedKey)
        UserDefaults.standard.removeObject(forKey: RescoreBackgroundScheduler.owedTokenKey)
    }

    override func tearDown() {
        restore(savedServerScoring, ServerScoringSettings.defaultsKey)
        restore(savedOwed, RescoreBackgroundScheduler.owedKey)
        restore(savedToken, RescoreBackgroundScheduler.owedTokenKey)
        super.tearDown()
    }

    private func restore(_ value: Any?, _ key: String) {
        if let value { UserDefaults.standard.set(value, forKey: key) }
        else { UserDefaults.standard.removeObject(forKey: key) }
    }

    func testDefaultOnWhenUnset() {
        XCTAssertTrue(ServerScoringSettings.isEnabled)
    }

    func testSkipsSyncCoupledRescoreWhenFlagOn() {
        ServerScoringSettings.setEnabled(true)
        XCTAssertTrue(ServerScoringSettings.skipsSyncCoupledRescore)
    }

    func testRunsSyncCoupledRescoreWhenFlagOff() {
        ServerScoringSettings.setEnabled(false)
        XCTAssertFalse(ServerScoringSettings.skipsSyncCoupledRescore)
    }

    func testSettleSkippedLocalRescoreDebtClearsOwedMark() {
        ServerScoringSettings.setEnabled(true)
        _ = RescoreBackgroundScheduler.markRescoreOwed()
        XCTAssertTrue(RescoreBackgroundScheduler.isRescoreOwed)
        ServerScoringSettings.settleSkippedLocalRescoreDebt()
        XCTAssertFalse(RescoreBackgroundScheduler.isRescoreOwed)
    }

    func testSettleSkippedLocalRescoreDebtNoOpWhenFlagOff() {
        ServerScoringSettings.setEnabled(false)
        _ = RescoreBackgroundScheduler.markRescoreOwed()
        ServerScoringSettings.settleSkippedLocalRescoreDebt()
        XCTAssertTrue(RescoreBackgroundScheduler.isRescoreOwed)
    }

    func testPushIntervalTightensWhenServerScoringOn() {
        XCTAssertEqual(CloudPushPeriodicScheduler.effectiveInterval(serverScoringEnabled: true), 45, accuracy: 0.001)
        XCTAssertEqual(CloudPushPeriodicScheduler.effectiveInterval(serverScoringEnabled: false),
                       CloudPushPeriodicScheduler.defaultInterval, accuracy: 0.001)
    }
}
