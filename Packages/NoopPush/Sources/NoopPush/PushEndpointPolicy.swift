import Foundation

public enum PushEndpointProblem: Sendable {
    case malformedURL
    case missingScheme
    case unsupportedScheme
    case userInfoNotAllowed
    case fragmentNotAllowed
    case missingHost
    case invalidHost
    case invalidPort
    case httpRequiresLocalAddress
}

public struct PushValidEndpoint: Sendable {
    public let url: String
    public let host: String

    public init(url: String, host: String) {
        self.url = url
        self.host = host
    }
}

public enum PushEndpointValidation: Sendable {
    case valid(PushValidEndpoint)
    case invalid(PushEndpointProblem)
}

public enum PushEndpointPolicy {
    public static func validate(_ raw: String) -> PushEndpointValidation {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed), let scheme = components.scheme?.lowercased() else {
            if trimmed.contains("://") {
                return .invalid(.malformedURL)
            }
            return .invalid(.missingScheme)
        }
        guard scheme == "http" || scheme == "https" else { return .invalid(.unsupportedScheme) }
        if components.user != nil || components.password != nil { return .invalid(.userInfoNotAllowed) }
        if components.fragment != nil { return .invalid(.fragmentNotAllowed) }
        guard let host = components.host?.lowercased(), !host.isEmpty else { return .invalid(.missingHost) }
        let asciiHost = host
        if let port = components.port, port < 0 || port > 65535 { return .invalid(.invalidPort) }

        let literalAllowed = isLocalLiteralHost(asciiHost)
        if scheme == "http", !literalAllowed { return .invalid(.httpRequiresLocalAddress) }

        let defaultPort = (scheme == "https" && (components.port == nil || components.port == 443))
            || (scheme == "http" && (components.port == nil || components.port == 80))
        let authorityHost = asciiHost.contains(":") ? "[\(asciiHost)]" : asciiHost
        let authority = authorityHost + ((components.port != nil && !defaultPort) ? ":\(components.port!)" : "")
        let path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        var normalized = "\(scheme)://\(authority)\(path)"
        if let query = components.percentEncodedQuery { normalized += "?\(query)" }
        return .valid(PushValidEndpoint(url: normalized, host: asciiHost))
    }

    private static func isLocalLiteralHost(_ host: String) -> Bool {
        if host == "localhost" || host.hasSuffix(".local") { return true }
        if host.hasPrefix("fc") || host.hasPrefix("fd") { return true } // IPv6 ULA shorthand
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else { return host.contains(":") } // IPv6 literal
        if parts[0] == 10 { return true }
        if parts[0] == 172 && (16...31).contains(parts[1]) { return true }
        if parts[0] == 192 && parts[1] == 168 { return true }
        if parts[0] == 169 && parts[1] == 254 { return true }
        if parts[0] == 127 { return true }
        return false
    }
}
