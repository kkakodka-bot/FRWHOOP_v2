import Foundation
import CryptoKit
import NoopPush

/// Push configuration. The destination and bearer token are baked into the build (Info.plist,
/// from Config/CloudPush.xcconfig) and are the same for every user — there is no per-user
/// endpoint or token override. Only toggles and run-state persist in UserDefaults.
enum CloudPushSettings {
    enum RunState: String {
        case idle, queued, running, continuing, retrying, complete, failed
    }

    struct Snapshot {
        let enabled: Bool
        let binaryObjectsEnabled: Bool
        let wifiOnly: Bool
        let endpoint: PushValidEndpoint?
        let hasToken: Bool
        let lastSuccessAt: Date?
        let lastError: String?
        let runState: RunState
        let acceptedBatches: Int
        let acceptedRecords: Int
        let supportedStreams: [String]?
        let capabilitiesCheckedAt: Date?

        var ready: Bool { enabled && endpoint != nil && hasToken }
    }

    private enum K {
        static let enabled = "cloudPush.enabled"
        static let binaryObjectsEnabled = "cloudPush.binaryObjectsEnabled"
        static let sourceId = "cloudPush.sourceId"
        static let wifiOnly = "cloudPush.wifiOnly"
        static let lastSuccess = "cloudPush.lastSuccessAt"
        static let lastError = "cloudPush.lastError"
        static let runState = "cloudPush.runState"
        static let acceptedBatches = "cloudPush.acceptedBatches"
        static let acceptedRecords = "cloudPush.acceptedRecords"
        static let capabilitiesEndpoint = "cloudPush.capabilitiesEndpoint"
        static let capabilitiesStreams = "cloudPush.capabilitiesStreams"
        static let capabilitiesAt = "cloudPush.capabilitiesAt"
        static let nextDevicePrefix = "cloudPush.nextDevice."
        static let cycleMorePrefix = "cloudPush.cycleMore."
    }

    /// Fleet destination baked into Info.plist at build time from Config/CloudPush.xcconfig
    /// (gitignored secrets in Config/CloudPushSecrets.xcconfig). This is the only destination —
    /// builds without the secrets file simply have push unconfigured. An unresolved `$(…)`
    /// placeholder reads as absent.
    private static func bundleValue(_ key: String) -> String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.hasPrefix("$(") else { return nil }
        return value
    }

    static var isEnabled: Bool {
        if UserDefaults.standard.object(forKey: K.enabled) == nil { return true }
        return UserDefaults.standard.bool(forKey: K.enabled)
    }
    static var binaryObjectsEnabled: Bool {
        if UserDefaults.standard.object(forKey: K.binaryObjectsEnabled) == nil { return true }
        return UserDefaults.standard.bool(forKey: K.binaryObjectsEnabled)
    }
    static var endpointText: String {
        bundleValue("NOOPPushEndpoint") ?? ""
    }

    /// The bearer the worker sends: the fleet token baked into the bundle. Never written to the
    /// keychain — rotation only needs a new build, not a per-device keychain migration.
    static func resolvedToken() -> String? {
        bundleValue("NOOPPushToken")
    }
    static var wifiOnly: Bool {
        if UserDefaults.standard.object(forKey: K.wifiOnly) == nil { return true }
        return UserDefaults.standard.bool(forKey: K.wifiOnly)
    }

    static var ready: Bool { isEnabled && isConfigured }

    private static var isConfigured: Bool {
        guard case .valid = PushEndpointPolicy.validate(endpointText) else { return false }
        return resolvedToken() != nil
    }

    static func snapshot() -> Snapshot {
        let endpoint: PushValidEndpoint?
        if case .valid(let valid) = PushEndpointPolicy.validate(endpointText) {
            endpoint = valid
        } else {
            endpoint = nil
        }
        let supported = capabilitiesFor(endpoint: endpoint)
        return Snapshot(
            enabled: isEnabled,
            binaryObjectsEnabled: binaryObjectsEnabled,
            wifiOnly: wifiOnly,
            endpoint: endpoint,
            hasToken: resolvedToken() != nil,
            lastSuccessAt: UserDefaults.standard.object(forKey: K.lastSuccess).map { Date(timeIntervalSince1970: $0 as? TimeInterval ?? 0) },
            lastError: UserDefaults.standard.string(forKey: K.lastError),
            runState: RunState(rawValue: UserDefaults.standard.string(forKey: K.runState) ?? "") ?? .idle,
            acceptedBatches: max(0, UserDefaults.standard.integer(forKey: K.acceptedBatches)),
            acceptedRecords: max(0, UserDefaults.standard.integer(forKey: K.acceptedRecords)),
            supportedStreams: supported,
            capabilitiesCheckedAt: {
                let at = UserDefaults.standard.double(forKey: K.capabilitiesAt)
                return at > 0 && supported != nil ? Date(timeIntervalSince1970: at) : nil
            }()
        )
    }

    static func enabledEndpoint() -> PushValidEndpoint? {
        guard isEnabled else { return nil }
        guard case .valid(let endpoint) = PushEndpointPolicy.validate(endpointText) else { return nil }
        return endpoint
    }

    @discardableResult
    static func setEnabled(_ enabled: Bool) -> Bool {
        if enabled && !isConfigured { return false }
        UserDefaults.standard.set(enabled, forKey: K.enabled)
        if !enabled {
            UserDefaults.standard.removeObject(forKey: K.lastError)
            UserDefaults.standard.set(RunState.idle.rawValue, forKey: K.runState)
        }
        return true
    }

    static func setBinaryObjectsEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: K.binaryObjectsEnabled)
    }

    static func setWifiOnly(_ wifiOnly: Bool) {
        UserDefaults.standard.set(wifiOnly, forKey: K.wifiOnly)
    }

    static func sourceId() -> String {
        if let existing = UserDefaults.standard.string(forKey: K.sourceId),
           UUID(uuidString: existing) != nil {
            return existing
        }
        let generated = UUID().uuidString.lowercased()
        UserDefaults.standard.set(generated, forKey: K.sourceId)
        return generated
    }

    static func progressNamespace(
        sourceId: String,
        endpoint: PushValidEndpoint,
        protocolVersion: String = PushProtocol.version,
        receiverStateId: String = PushCapabilities.unscopedReceiverStateId
    ) -> String {
        let seed = "\(sourceId)\u{0000}\(endpoint.url)\u{0000}\(protocolVersion)\u{0000}\(receiverStateId)"
        let digest = SHA256.hash(data: Data(seed.utf8))
        return digest.prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    static func recordPushStarted() {
        guard isEnabled else { return }
        UserDefaults.standard.removeObject(forKey: K.lastError)
        UserDefaults.standard.set(0, forKey: K.acceptedBatches)
        UserDefaults.standard.set(0, forKey: K.acceptedRecords)
        UserDefaults.standard.set(RunState.queued.rawValue, forKey: K.runState)
    }

    static func recordRunning() {
        guard isEnabled else { return }
        UserDefaults.standard.set(RunState.running.rawValue, forKey: K.runState)
    }

    static func recordAcceptedBatches(batches: Int, records: Int) {
        guard isEnabled, batches > 0 || records > 0 else { return }
        let defaults = UserDefaults.standard
        defaults.set(defaults.integer(forKey: K.acceptedBatches) + max(0, batches), forKey: K.acceptedBatches)
        defaults.set(defaults.integer(forKey: K.acceptedRecords) + max(0, records), forKey: K.acceptedRecords)
    }

    static func recordContinuation() {
        guard isEnabled else { return }
        UserDefaults.standard.removeObject(forKey: K.lastError)
        UserDefaults.standard.set(RunState.continuing.rawValue, forKey: K.runState)
    }

    static func recordRetrying(message: String) {
        guard isEnabled else { return }
        UserDefaults.standard.set(String(message.prefix(300)), forKey: K.lastError)
        UserDefaults.standard.set(RunState.retrying.rawValue, forKey: K.runState)
    }

    static func recordSuccess() {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: K.lastSuccess)
        UserDefaults.standard.removeObject(forKey: K.lastError)
        UserDefaults.standard.set(RunState.complete.rawValue, forKey: K.runState)
    }

    static func recordError(_ message: String) {
        UserDefaults.standard.set(String(message.prefix(300)), forKey: K.lastError)
        UserDefaults.standard.set(RunState.failed.rawValue, forKey: K.runState)
    }

    static func recordCapabilities(
        endpoint: PushValidEndpoint,
        capabilities: PushCapabilities,
        checkedAt: Date = Date()
    ) {
        UserDefaults.standard.set(endpoint.url, forKey: K.capabilitiesEndpoint)
        UserDefaults.standard.set(capabilities.wireNames.joined(separator: ","), forKey: K.capabilitiesStreams)
        UserDefaults.standard.set(checkedAt.timeIntervalSince1970, forKey: K.capabilitiesAt)
    }

    static func nextDeviceIndex(namespace: String) -> Int {
        max(0, UserDefaults.standard.integer(forKey: K.nextDevicePrefix + namespace))
    }

    static func saveNextDeviceIndex(namespace: String, index: Int) {
        UserDefaults.standard.set(max(0, index), forKey: K.nextDevicePrefix + namespace)
    }

    static func cycleNeedsAnotherPass(namespace: String) -> Bool {
        UserDefaults.standard.bool(forKey: K.cycleMorePrefix + namespace)
    }

    static func saveCycleNeedsAnotherPass(namespace: String, needed: Bool) {
        UserDefaults.standard.set(needed, forKey: K.cycleMorePrefix + namespace)
    }

    private static func capabilitiesFor(endpoint: PushValidEndpoint?) -> [String]? {
        guard let endpoint,
              UserDefaults.standard.string(forKey: K.capabilitiesEndpoint) == endpoint.url,
              UserDefaults.standard.object(forKey: K.capabilitiesStreams) != nil else { return nil }
        let encoded = UserDefaults.standard.string(forKey: K.capabilitiesStreams) ?? ""
        if encoded.isEmpty { return [] }
        let names = encoded.split(separator: ",").map(String.init)
        let known = Set(PushCapabilities.all.wireNames)
        guard names.count == Set(names).count, names.allSatisfy(known.contains) else { return nil }
        return names
    }

}
