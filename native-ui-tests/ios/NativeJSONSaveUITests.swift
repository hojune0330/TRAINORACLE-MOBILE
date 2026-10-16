import XCTest

final class NativeJSONSaveUITests: XCTestCase {
    private let destination = XCUIApplication(bundleIdentifier: "io.trainoracle.ci.pickerdestination")
    private let app = XCUIApplication(bundleIdentifier: "io.trainoracle.app.debug")
    private enum Failure: Error { case unsupportedUI }

    override func setUpWithError() throws { continueAfterFailure = false }

    private func evidence(_ name: String) {
        // The shell creates a new CI-owned simulator. No existing user UI/data.
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = name + "-fresh-ci-hierarchy"; tree.lifetime = .keepAlways; add(tree)
    }
    private func fail(_ reason: String) throws -> Never {
        evidence("unsupported-ui")
        XCTFail(reason)
        throw Failure.unsupportedUI
    }
    private func unique(_ query: XCUIElementQuery, labels: [String], timeout: TimeInterval = 12) throws -> XCUIElement {
        let matching = query.matching(NSPredicate(format: "label IN %@", labels))
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let hits = matching.allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
            if hits.count == 1 { return hits[0] }
            if hits.count > 1 { try fail("Ambiguous accessible control") }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        } while Date() < deadline
        try fail("Required accessible control not observed")
    }
    private func backupButtonOnProvenMorePage() throws -> XCUIElement {
        // These two observed controls distinguish the opened More page from
        // the home screen's More button. No scrolling on an unproven page.
        _ = try unique(app.buttons, labels: ["홈으로 돌아가기"], timeout: 20)
        _ = try unique(app.staticTexts, labels: ["더보기"], timeout: 20)
        evidence("more-page-proven")
        for attempt in 0...4 {
            // Resolve the exact backup label anew after every genuine swipe.
            let matches = app.buttons.matching(NSPredicate(format: "label == %@", "백업·복원·휴지통"))
                .allElementsBoundByIndex.filter { $0.exists }
            if matches.count > 1 { try fail("Ambiguous backup navigation control") }
            if let button = matches.first, button.isHittable { return button }
            guard attempt < 4 else { try fail("Backup navigation not reachable within four swipes") }
            let webViews = app.webViews.allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
            guard webViews.count == 1 else { try fail("No unique real WebView for More navigation") }
            webViews[0].swipeUp()
            RunLoop.current.run(until: Date().addingTimeInterval(0.4))
            evidence("more-backup-scroll-\(attempt + 1)")
        }
        try fail("Backup navigation not reached")
    }
    private func location(_ label: [String]) throws -> XCUIElement {
        // Static text inside a native Files cell is a real hittable UI element.
        // Never use WebView coordinates, JavaScript or synthetic event flags.
        try unique(app.staticTexts, labels: label)
    }
    private func saveButton() throws -> XCUIElement {
        try unique(app.navigationBars.buttons, labels: ["Save", "SAVE", "저장"], timeout: 20)
    }
    func testActualNativeJSONSaveToOwnedLocalFolder() throws {
        defer { evidence("final-state") }
        destination.launch()
        guard destination.staticTexts["ci-destination-ready"].waitForExistence(timeout: 20) else {
            try fail("Destination folder was not freshly prepared")
        }
        app.launch()
        guard app.wait(for: .runningForeground, timeout: 30) else { try fail("Preinstalled app did not foreground") }
        evidence("app-home")
        // Export only. Never tap restore, import, clear, delete, trash or reset.
        try unique(app.buttons, labels: ["더보기"], timeout: 40).tap()
        try backupButtonOnProvenMorePage().tap()
        evidence("safe-backup-page")
        try unique(app.buttons, labels: ["내 일지 데이터 내려받기 (JSON)"], timeout: 40).tap()
        evidence("export-native-handoff")
        // A native navigation-bar Save control is required before browsing.
        _ = try saveButton()
        let localLabels = ["On My iPhone", "나의 iPhone"]
        let local = app.staticTexts.matching(NSPredicate(format: "label IN %@", localLabels))
        if !local.allElementsBoundByIndex.contains(where: { $0.exists && $0.isHittable }) {
            // Only the explicitly labelled native location navigation is allowed.
            // Never select iCloud, a recent file, arbitrary Back or a guessed cell.
            try unique(app.navigationBars.buttons, labels: ["Browse", "둘러보기", "탐색", "Locations", "위치"]).tap()
        }
        try location(localLabels).tap()
        evidence("proven-on-my-iphone")
        try location(["TrainOracle CI Destination"]).tap()
        evidence("owned-destination-app")
        try location(["NativeJSONSave"]).tap()
        guard app.navigationBars["NativeJSONSave"].waitForExistence(timeout: 15) else {
            try fail("Owned local destination folder not proven")
        }
        let save = try saveButton()
        evidence("owned-folder-before-save")
        // Keep the original suggested filename; never guess/edit picker fields.
        save.tap() // Exactly one real native Save activation.
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: save)
        guard XCTWaiter.wait(for: [dismissed], timeout: 30) == .completed else {
            try fail("Native Save did not dismiss the picker")
        }
        evidence("native-save-dismissed")
        // The host-side script independently checks ONLY the owned destination
        // folder's exact one new JSON file; dismissal alone is not a pass.
    }
}
