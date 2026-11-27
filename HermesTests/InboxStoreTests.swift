import XCTest
@testable import Hermes

final class InboxStoreTests: XCTestCase {
    private var directory: URL!
    private var originalStorageURL: URL!
    private let profileID = UUID()

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("inbox-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        originalStorageURL = InboxStore.storageURL
        InboxStore.storageURL = directory.appendingPathComponent("inbox-items.json")
    }

    override func tearDown() {
        InboxStore.storageURL = originalStorageURL
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    func testUpsertSortsNewestFirstAndReplacesSameID() throws {
        let older = item(id: "older", title: "旧事项", createdAt: Date(timeIntervalSince1970: 1_700_000_000))
        let newer = item(id: "newer", title: "新事项", createdAt: Date(timeIntervalSince1970: 1_700_000_100))
        try InboxStore.upsert(older)
        try InboxStore.upsert(newer)
        XCTAssertEqual(try InboxStore.items(profileID: profileID).map(\.id), ["newer", "older"])

        let promoted = item(id: "older", title: "已更新", createdAt: Date(timeIntervalSince1970: 1_700_000_200))
        try InboxStore.upsert(promoted)
        XCTAssertEqual(try InboxStore.items(profileID: profileID).map(\.id), ["older", "newer"])
        XCTAssertEqual(try InboxStore.items(profileID: profileID).first?.title, "已更新")
        XCTAssertEqual(try InboxStore.items(profileID: profileID).count, 2)
    }

    func testRemoveAndPersistAcrossANewRead() throws {
        let kept = item(id: "keep", title: "留下", createdAt: Date(timeIntervalSince1970: 1_700_000_050))
        let dropped = item(id: "drop", title: "删掉", createdAt: Date(timeIntervalSince1970: 1_700_000_080))
        try InboxStore.upsert(kept)
        try InboxStore.upsert(dropped)
        try InboxStore.remove(id: "drop", profileID: profileID)
        try InboxStore.remove(id: "missing", profileID: profileID)

        let url = InboxStore.storageURL
        let raw = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(raw.contains("留下"))
        XCTAssertFalse(raw.contains("删掉"))

        InboxStore.storageURL = url
        let reread = try InboxStore.items(profileID: profileID)
        XCTAssertEqual(reread, [kept])
        XCTAssertEqual(InboxStore.didChange.rawValue, "HermesInboxDidChange")
        XCTAssertEqual(try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testSameIDOnAnotherProfileRemainsIsolated() throws {
        let otherProfileID = UUID()
        let first = item(id: "same", title: "本连接", createdAt: Date())
        var other = first
        other.profileID = otherProfileID
        other.title = "另一连接"
        try InboxStore.upsert(first)
        try InboxStore.upsert(other)

        XCTAssertEqual(try InboxStore.items(profileID: profileID), [first])
        XCTAssertEqual(try InboxStore.items(profileID: otherProfileID), [other])
        try InboxStore.removeAll(profileID: profileID)
        XCTAssertTrue(try InboxStore.items(profileID: profileID).isEmpty)
        XCTAssertEqual(try InboxStore.items(profileID: otherProfileID), [other])
        XCTAssertEqual(try InboxStore.items(profileID: otherProfileID).first?.choices, ["session", "deny"])
        XCTAssertEqual(try InboxStore.items(profileID: otherProfileID).first?.command, "cat ~/notes.txt")
    }

    func testCorruptFileIsNotOverwritten() throws {
        let url = InboxStore.storageURL
        let corrupt = Data("not-json".utf8)
        try corrupt.write(to: url)

        XCTAssertThrowsError(try InboxStore.items(profileID: profileID))
        XCTAssertThrowsError(try InboxStore.upsert(item(id: "new", title: "新事项", createdAt: Date())))
        XCTAssertThrowsError(try InboxStore.removeAll(profileID: profileID))
        XCTAssertEqual(try Data(contentsOf: url), corrupt)
    }

    @MainActor
    func testInboxKeepsFailedApprovalAndIgnoresStaleTapAfterSuccess() async throws {
        let pending = item(id: "pending", title: "审批", createdAt: Date())
        try InboxStore.upsert(pending)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [InboxApprovalProtocol.self]
        let client = HermesClient(
            settings: ConnectionSettings(serverURL: "https://inbox.hermes.test", model: "hermes-agent",
                                         apiKey: "fixture", profileID: profileID),
            sessionConfiguration: configuration
        )
        let inbox = InboxController(client: client)

        await inbox.resolve(pending, choice: "deny")
        XCTAssertNotNil(inbox.errorText)
        XCTAssertEqual(inbox.approvals, [pending])
        XCTAssertEqual(try InboxStore.items(profileID: profileID), [pending])

        inbox.errorText = nil
        await inbox.resolve(pending, choice: "session")
        XCTAssertTrue(inbox.approvals.isEmpty)
        XCTAssertTrue(try InboxStore.items(profileID: profileID).isEmpty)

        await inbox.resolve(pending, choice: "deny")
        XCTAssertNil(inbox.errorText)
    }

    private func item(id: String, title: String, createdAt: Date) -> InboxItem {
        InboxItem(id: id, profileID: profileID, sessionID: "session-\(id)", sessionTitle: "会话",
            runID: "run-\(id)", requestID: "request-\(id)", command: "cat ~/notes.txt",
            choices: ["session", "deny"],
            kind: .approval, title: title,
            detail: "详情", createdAt: createdAt)
    }
}

private final class InboxApprovalProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        let body = try? JSONDecoder().decode([String: String].self, from: bodyData())
        let sessionAllowed = request.httpMethod == "POST" && url.path == "/v1/runs/run-pending/approval"
            && body?["request_id"] == "request-pending" && body?["choice"] == "session"
        let response = HTTPURLResponse(url: url, statusCode: sessionAllowed ? 200 : 503, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((sessionAllowed ? #"{"resolved":1}"# : #"{"error":"retry"}"#).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private func bodyData() -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }
}
