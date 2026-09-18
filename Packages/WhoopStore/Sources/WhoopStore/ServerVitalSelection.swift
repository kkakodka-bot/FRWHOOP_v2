import Foundation

/// Chooses one explicit mode for a Today vital. A missing server value never borrows local history.
/// The caller supplies an owner-scoped overlay only after configuration and authentication checks.
public struct ServerVitalSelection: Equatable {
    public enum Metric: CaseIterable { case hrv, restingHR, respiratory }
    public let value: Double?
    public let fromServer: Bool
    public let day: String
    public let status: String?
    public let stale: Bool
    public let sourceFeature: String?
    public let deviceId: String?
    public let algorithmVersion: String?

    public static func resolve(_ metric: Metric, serverEnabled: Bool, selectedDay: String,
                               overlay: ServerScoreDayCache?, localValue: Double?) -> Self {
        guard serverEnabled else {
            return Self(value: localValue, fromServer: false, day: selectedDay, status: nil, stale: false,
                        sourceFeature: nil, deviceId: nil, algorithmVersion: nil)
        }
        guard let overlay, overlay.day == selectedDay else {
            return Self(value: nil, fromServer: true, day: selectedDay, status: "unavailable", stale: false,
                        sourceFeature: nil, deviceId: nil, algorithmVersion: nil)
        }
        let value: Double?
        let featureKey: String
        switch metric {
        case .hrv: value = overlay.daily?.hrvRmssdMs; featureKey = "hrv"
        case .restingHR: value = overlay.daily?.restingHrBpm.map(Double.init); featureKey = "hrv"
        case .respiratory: value = overlay.daily?.respRateBpm; featureKey = "respiration"
        }
        let feature = overlay.features[featureKey]
        let status = feature?.status ?? "unavailable"
        let available = status == "available" || status == "stale"
        return Self(value: available ? value : nil, fromServer: true, day: selectedDay,
                    status: available && value == nil ? "unavailable" : status,
                    stale: overlay.stale || status == "stale", sourceFeature: feature == nil ? nil : featureKey,
                    deviceId: feature?.deviceId, algorithmVersion: feature?.algorithmVersion)
    }
}
