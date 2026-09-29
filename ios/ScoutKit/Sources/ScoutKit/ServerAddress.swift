import Foundation

public enum ServerAddressError: Error, Equatable, LocalizedError {
    case empty
    case invalid
    case unsupportedScheme
    case credentialsNotAllowed
    case queryNotAllowed

    public var errorDescription: String? {
        switch self {
        case .empty: "Enter the address of your Scout server."
        case .invalid: "That doesn't look like a valid server address."
        case .unsupportedScheme: "Use an http:// or https:// address."
        case .credentialsNotAllowed: "Remove the username and password from the address."
        case .queryNotAllowed: "Remove the query string or fragment from the address."
        }
    }
}

/// Normalizes what the user types into a base URL: `scout.lan:3001` becomes
/// `https://scout.lan:3001`, trailing slashes are dropped, and a reverse-proxy
/// path prefix such as `/scout` is kept.
public enum ServerAddress {
    public static func normalize(_ input: String) throws -> URL {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw ServerAddressError.empty }
        if !text.contains("://") { text = "https://" + text }
        guard var components = URLComponents(string: text) else { throw ServerAddressError.invalid }
        guard let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            throw ServerAddressError.unsupportedScheme
        }
        guard let host = components.host, !host.isEmpty else { throw ServerAddressError.invalid }
        if components.user != nil || components.password != nil { throw ServerAddressError.credentialsNotAllowed }
        if components.query != nil || components.fragment != nil { throw ServerAddressError.queryNotAllowed }
        components.scheme = scheme
        components.host = host.lowercased()
        while components.path.hasSuffix("/") { components.path.removeLast() }
        guard let url = components.url else { throw ServerAddressError.invalid }
        return url
    }
}
