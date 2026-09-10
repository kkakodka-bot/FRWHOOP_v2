import XCTest
@testable import Strand
import WhoopStore

final class SyncDrainPolicyTests: XCTestCase {

    func testOffloadCompleteRunsEveryStageEvenWhenNotOwed() {
        let owed: Set<SyncJobKind> = []
        for stage in SyncDrainPolicy.stageOrder {
            XCTAssertTrue(
                SyncDrainPolicy.shouldRun(stage: stage, owedKinds: owed, reason: .offloadComplete),
                "offloadComplete should run \(stage.rawValue)"
            )
        }
    }

    func testForegroundRunsOnlyOwedStages() {
        let owed: Set<SyncJobKind> = [.cloudPush, .widgetPublish]
        XCTAssertTrue(SyncDrainPolicy.shouldRun(stage: .cloudPush, owedKinds: owed, reason: .foreground))
        XCTAssertFalse(SyncDrainPolicy.shouldRun(stage: .rescore, owedKinds: owed, reason: .foreground))
        XCTAssertTrue(SyncDrainPolicy.shouldRun(stage: .widgetPublish, owedKinds: owed, reason: .foreground))
        XCTAssertFalse(SyncDrainPolicy.shouldRun(stage: .healthWriteback, owedKinds: owed, reason: .foreground))
    }

    func testStageOrderIsStable() {
        XCTAssertEqual(
            SyncDrainPolicy.stageOrder,
            [.rescore, .cloudPush, .healthWriteback, .widgetPublish]
        )
    }
}
