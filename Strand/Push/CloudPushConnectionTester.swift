import Foundation
import NoopPush

/// Capabilities GET probe for the settings screen. Sends no health data.
enum CloudPushConnectionTester {
    static func test(endpoint: PushValidEndpoint, token: String) async -> PushCapabilitiesResult {
        let transport = CloudPushTransport(endpoint: endpoint, bearerToken: token)
        return (try? await transport.capabilities()) ?? .rejected(
            reason: PushFailure(code: .networkIO).safeCode,
            retryable: true,
            failure: PushFailure(code: .networkIO)
        )
    }
}
