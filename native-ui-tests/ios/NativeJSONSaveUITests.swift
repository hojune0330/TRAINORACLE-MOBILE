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
    private func morePageObserved() -> Bool {
        let back = app.buttons.matching(NSPredicate(format: "label == %@", "홈으로 돌아가기"))
            .allElementsBoundByIndex.filter { $0.exists }
        let title = app.staticTexts.matching(NSPredicate(format: "label == %@", "더보기"))
            .allElementsBoundByIndex.filter { $0.exists }
        return back.count == 1 && title.count == 1
    }
    private func freshHomeMore() -> XCUIElement? {
        guard app.state == .runningForeground else { return nil }
        // Positive home evidence AND absence of More-page signals are required.
        // No frame is used as a touch coordinate; it is only a stability check.
        for label in ["홈으로 돌아가기", "백업·복원·휴지통"] {
            if app.buttons.matching(NSPredicate(format: "label == %@", label)).count != 0 { return nil }
        }
        if app.staticTexts.matching(NSPredicate(format: "label == %@", "훈련 도구")).count != 0 { return nil }
        let heading = app.staticTexts.matching(NSPredicate(format: "label == %@", "운동 분석과 훈련 계획"))
            .allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
        guard heading.count == 1 else { return nil }
        for label in ["훈련 계획 받기", "오늘 운동 기록 쓰기"] {
            let hits = app.buttons.matching(NSPredicate(format: "label == %@", label))
                .allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
            guard hits.count == 1 else { return nil }
        }
        let more = app.buttons.matching(NSPredicate(format: "label == %@", "더보기"))
            .allElementsBoundByIndex.filter { $0.exists }
        guard more.count == 1, more[0].isHittable,
              more[0].frame.width > 0, more[0].frame.height > 0 else { return nil }
        return more[0]
    }
    private func stableHomeMore(timeout: TimeInterval) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)
        var previousFrame = app.frame
        var stableSamples = 0
        repeat {
            guard !morePageObserved() else { return nil }
            if let button = freshHomeMore() {
                stableSamples = button.frame == previousFrame ? stableSamples + 1 : 1
                previousFrame = button.frame
                if stableSamples >= 3 { return button }
            } else { stableSamples = 0 }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        } while Date() < deadline
        return nil
    }
    private func waitForMorePage(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if morePageObserved() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline
        return false
    }
    private func openMoreWithOneConditionalRecovery() throws {
        guard stableHomeMore(timeout: 60) != nil else {
            try fail("more-home-ax-not-stable")
        }
        evidence("more-before-first-tap-stable-home")
        guard let first = freshHomeMore() else { try fail("more-home-changed-before-tap") }
        first.tap() // One initial navigation action, never an export/save retry.
        if waitForMorePage(timeout: 20) { evidence("more-after-first-tap-opened"); return }
        evidence("more-after-first-tap-no-navigation")
        // A retry is permitted ONLY after fresh observations prove unchanged
        // HOME, a unique hittable More button, and no More-page signals.
        if morePageObserved() { return }
        guard stableHomeMore(timeout: 8) != nil else {
            try fail("more-tap-no-navigation: unchanged-home-not-proven")
        }
        evidence("more-before-single-press-retry")
        if morePageObserved() { return }
        guard let retry = freshHomeMore() else {
            try fail("more-tap-no-navigation: home-changed-before-retry")
        }
        retry.press(forDuration: 0.1) // Sole allowed genuine navigation recovery.
        if waitForMorePage(timeout: 20) { evidence("more-after-press-retry-opened"); return }
        evidence("more-after-single-press-retry-no-navigation")
        try fail("more-tap-no-navigation")
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
            // R11 AX has three nested WebView wrappers for one document.
            // Its unique DOM main is the More content viewport; the bottom
            // "주 탭, navigation" is a sibling, outside this scroll surface.
            // Requery the surface AND its page proof on every bounded swipe.
            let mains = app.otherElements.matching(NSPredicate(format: "label == %@", "main"))
                .allElementsBoundByIndex.filter { $0.exists }
            guard mains.count == 1 else { try fail("Ambiguous or absent DOM main scroll surface") }
            let main = mains[0]
            let back = main.buttons.matching(NSPredicate(format: "label == %@", "홈으로 돌아가기"))
                .allElementsBoundByIndex.filter { $0.exists }
            let title = main.staticTexts.matching(NSPredicate(format: "label == %@", "더보기"))
                .allElementsBoundByIndex.filter { $0.exists }
            let backup = main.buttons.matching(NSPredicate(format: "label == %@", "백업·복원·휴지통"))
                .allElementsBoundByIndex.filter { $0.exists }
            let tabLabels = ["주 탭", "주 탭, navigation"]
            let tabs = app.otherElements.matching(NSPredicate(format: "label IN %@", tabLabels))
                .allElementsBoundByIndex.filter { $0.exists }
            guard back.count == 1, title.count == 1, backup.count == 1,
                  tabs.count == 1, main.isHittable,
                  main.frame.width > 0, main.frame.height > 0,
                  app.frame.contains(main.frame),
                  main.frame.maxY <= tabs[0].frame.minY + 1,
                  main.descendants(matching: .any).matching(NSPredicate(format: "label IN %@", tabLabels)).count == 0 else {
                try fail("More DOM main subtree or bottom-tab boundary not proven")
            }
            // Element-relative native swipe only; frames above are validation,
            // never event coordinates. Sibling/ambiguous main views fail closed.
            main.swipeUp()
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
    private func localPickerRoot(_ title: String) -> XCUIElement? {
        // R12 exposes the provider and current directory in this actual AX ID.
        // Never infer the current folder from its visible child label alone.
        let identifier = "DOC.browsingRoot Source: com.apple.FileProvider.LocalStorage, Title: " + title
        let roots = app.otherElements.matching(NSPredicate(format: "identifier == %@", identifier))
            .allElementsBoundByIndex.filter { $0.exists }
        guard roots.count == 1 else { return nil }
        return roots[0]
    }
    private func ownedParentFolderCell() -> XCUIElement? {
        guard let root = localPickerRoot("TrainOracle CI Destination") else { return nil }
        let bars = root.navigationBars.matching(identifier: "FullDocumentManagerViewControllerNavigationBar")
            .allElementsBoundByIndex.filter { $0.exists }
        guard bars.count == 1 else { return nil }
        let parentTitle = bars[0].buttons.matching(NSPredicate(format: "label == %@", "TrainOracle CI Destination, Actions Menu"))
            .allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
        let localBack = bars[0].buttons.matching(NSPredicate(format: "identifier == %@ AND label IN %@", "BackButton", ["On My iPhone", "나의 iPhone"]))
            .allElementsBoundByIndex.filter { $0.exists }
        let saves = bars[0].buttons.matching(NSPredicate(format: "label IN %@", ["Save", "SAVE", "저장"]))
            .allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
        let collections = root.collectionViews.matching(identifier: "File View")
            .allElementsBoundByIndex.filter { $0.exists }
        guard parentTitle.count == 1, localBack.count == 1, saves.count == 1,
              collections.count == 1 else { return nil }
        // The actual R12 icon-mode Cell owns the folder activation, not its
        // lower StaticText caption. No coordinates, double-tap or guessed cell.
        let cells = collections[0].cells.matching(identifier: "NativeJSONSave, Folder")
            .allElementsBoundByIndex.filter { $0.exists }
        guard cells.count == 1, cells[0].isHittable else { return nil }
        let labels = cells[0].staticTexts.matching(NSPredicate(format: "label == %@", "NativeJSONSave"))
            .allElementsBoundByIndex.filter { $0.exists }
        guard labels.count == 1 else { return nil }
        return cells[0]
    }
    private func ownedFolderProven() -> Bool {
        guard let root = localPickerRoot("NativeJSONSave") else { return false }
        // In R12 the navigation bar has a fixed identifier, NOT the directory
        // name. Its Actions Menu title plus the local-provider root identify
        // the newly opened folder without weakening the destination boundary.
        let bars = root.navigationBars.matching(identifier: "FullDocumentManagerViewControllerNavigationBar")
            .allElementsBoundByIndex.filter { $0.exists }
        guard bars.count == 1 else { return false }
        let title = bars[0].buttons.matching(NSPredicate(format: "label == %@", "NativeJSONSave, Actions Menu"))
            .allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
        let parentBack = bars[0].buttons.matching(NSPredicate(format: "identifier == %@ AND label == %@", "BackButton", "TrainOracle CI Destination"))
            .allElementsBoundByIndex.filter { $0.exists }
        let saves = bars[0].buttons.matching(NSPredicate(format: "label IN %@", ["Save", "SAVE", "저장"]))
            .allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
        let collections = root.collectionViews.matching(identifier: "File View")
            .allElementsBoundByIndex.filter { $0.exists }
        guard title.count == 1, parentBack.count == 1, saves.count == 1,
              collections.count == 1 else { return false }
        return collections[0].cells.allElementsBoundByIndex.filter { $0.exists }.isEmpty
    }
    private func waitForOwnedFolder(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if ownedFolderProven() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline
        return false
    }
    private func openOwnedDestinationFolder() throws {
        let deadline = Date().addingTimeInterval(20)
        while ownedParentFolderCell() == nil && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        evidence("owned-parent-before-folder-cell-tap")
        guard let first = ownedParentFolderCell() else {
            try fail("Owned local parent and unique folder cell not proven")
        }
        first.tap()
        if waitForOwnedFolder(timeout: 20) { evidence("owned-folder-opened-first-cell-tap"); return }
        evidence("owned-folder-after-first-cell-tap")
        if ownedFolderProven() { return }
        // Only navigation can be retried once, and only from the exact same
        // local parent with the exact same unique live folder Cell.
        guard ownedParentFolderCell() != nil else {
            try fail("owned-folder-navigation-unconfirmed: parent-state-not-proven")
        }
        evidence("owned-parent-before-single-folder-navigation-retry")
        if ownedFolderProven() { return }
        guard let retry = ownedParentFolderCell() else {
            try fail("owned-folder-navigation-unconfirmed: parent-state-changed")
        }
        retry.tap()
        if waitForOwnedFolder(timeout: 20) { evidence("owned-folder-opened-navigation-retry"); return }
        evidence("owned-folder-after-single-navigation-retry")
        try fail("owned-folder-navigation-unconfirmed")
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
        try openMoreWithOneConditionalRecovery()
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
        try openOwnedDestinationFolder()
        evidence("owned-folder-before-save")
        guard ownedFolderProven() else { try fail("Owned local destination folder not proven before Save") }
        let save = try saveButton()
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
