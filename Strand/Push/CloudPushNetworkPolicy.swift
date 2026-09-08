import Foundation
#if canImport(Network)
import Network
#endif

/// Wi‑Fi-only and connectivity gates for cloud push. Pure helpers mirror Android
/// `isPushNetworkAvailable` / `canStartPushConnectionTest`.
enum CloudPushNetworkPolicy {
    static func isPushNetworkAvailable(
        wifiOnly: Bool,
        isConnected: Bool,
        isWifi: Bool,
        isUnmetered: Bool
    ) -> Bool {
        isConnected && (!wifiOnly || (isWifi && isUnmetered))
    }

    static func canStartConnectionTest(
        networkAvailable: Bool,
        endpointValid: Bool,
        tokenAvailable: Bool
    ) -> Bool {
        networkAvailable && endpointValid && tokenAvailable
    }

    #if os(iOS)
    static func isNetworkAvailable(wifiOnly: Bool) -> Bool {
        let monitor = NWPathMonitor()
        let semaphore = DispatchSemaphore(value: 0)
        var snapshot = (connected: false, wifi: false, unmetered: false)
        monitor.pathUpdateHandler = { path in
            snapshot = (
                connected: path.status == .satisfied,
                wifi: path.usesInterfaceType(.wifi),
                unmetered: !path.isExpensive
            )
            semaphore.signal()
        }
        let queue = DispatchQueue(label: "com.noop.cloudpush.network")
        monitor.start(queue: queue)
        _ = semaphore.wait(timeout: .now() + 0.5)
        monitor.cancel()
        return isPushNetworkAvailable(
            wifiOnly: wifiOnly,
            isConnected: snapshot.connected,
            isWifi: snapshot.wifi,
            isUnmetered: snapshot.unmetered
        )
    }
    #endif
}
