// Agent Builder — окно приложения для конструктора агентов.
//
// Запускает server.py, показывает интерфейс во встроенном WebKit (без браузера)
// и выключает сервер при выходе. Сервер и интерфейс лежат внутри пакета
// (Contents/Resources/app), данные — в ~/Library/Application Support/Agent Builder.
// Собирается скриптом build.sh.
//
// Для разработки: AGENT_BUILDER_DIR — взять app/ из репозитория без пересборки,
// AGENT_BUILDER_PYTHON — конкретный python3, AGENT_BUILDER_DATA — другая папка данных.

import Cocoa
import WebKit

let env = ProcessInfo.processInfo.environment
let appDir = env["AGENT_BUILDER_DIR"] ?? (Bundle.main.resourcePath ?? ".") + "/app"
let dataDir = env["AGENT_BUILDER_DATA"] ?? NSHomeDirectory() + "/Library/Application Support/Agent Builder"
let logPath = dataDir + "/server.log"
// Сначала Python, поставленный вами (Homebrew, MacPorts, python.org), потом системный из Command Line Tools.
let pythonCandidates = [
    env["AGENT_BUILDER_PYTHON"] ?? "",
    "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/opt/local/bin/python3",
    "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
    "/Library/Developer/CommandLineTools/usr/bin/python3",
    "/Applications/Xcode.app/Contents/Developer/usr/bin/python3",
    "/usr/bin/python3",
].filter { !$0.isEmpty }

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var ownsServer = false
    var serverURL: URL?
    var output = ""
    var log: FileHandle?
    var startTimer: Timer?
    var quitting = false
    var titleObservation: NSKeyValueObservation?

    // MARK: запуск

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = NSSize(width: min(1440, visible.width * 0.92), height: min(920, visible.height * 0.92))
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Agent Builder"
        window.minSize = NSSize(width: 980, height: 620)
        window.tabbingMode = .disallowed
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("AgentBuilderMain")
        window.makeKeyAndOrderFront(nil)

        // Заголовок окна повторяет заголовок страницы: название системы и точка несохранённых правок.
        titleObservation = webView.observe(\.title) { [weak self] view, _ in
            if let title = view.title, !title.isEmpty { self?.window.title = title }
        }

        showMessage("Запускаю конструктор…")
        startServer()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        if ownsServer, let server = server, server.isRunning { server.terminate() }
    }

    // MARK: сервер

    func startServer() {
        serverURL = nil
        ownsServer = false
        output = ""
        guard FileManager.default.fileExists(atPath: appDir + "/server.py") else {
            return fail("Приложение повреждено",
                        "Внутри пакета нет файла \(appDir)/server.py.\nСкачайте Agent Builder заново или соберите: bash build.sh")
        }
        guard let python = pythonCandidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            return fail("Нужен Python 3", Self.pythonHelp)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = ["server.py", "--no-browser", "--announce", "--idle-exit", "3600",
                             "--parent-pid", String(ProcessInfo.processInfo.processIdentifier)]
        process.currentDirectoryURL = URL(fileURLWithPath: appDir)
        var childEnv = env
        childEnv["PYTHONUNBUFFERED"] = "1"
        childEnv["PYTHONDONTWRITEBYTECODE"] = "1"  // не мусорить __pycache__ внутри пакета
        process.environment = childEnv

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        openLog()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            self?.log?.write(data)
            let text = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async { self?.consume(text) }
        }
        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.serverExited(proc) }
        }

        do { try process.run() } catch {
            return fail("Не удалось запустить сервер", error.localizedDescription)
        }
        server = process
        startTimer?.invalidate()
        startTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in
            guard let self = self, self.serverURL == nil else { return }
            self.fail("Сервер не ответил за 20 секунд", self.logTail())
        }
    }

    // Сервер печатает «@url http://127.0.0.1:8766/ own|shared». own — запустили мы,
    // shared — нашёлся уже работающий, и наш процесс завершился.
    func consume(_ text: String) {
        output += text
        while let newline = output.firstIndex(of: "\n") {
            let line = String(output[..<newline])
            output.removeSubrange(...newline)
            guard line.hasPrefix("@url ") else { continue }
            let parts = line.split(separator: " ")
            guard parts.count >= 2, let url = URL(string: String(parts[1])) else { continue }
            ownsServer = parts.count > 2 && parts[2] == "own"
            if serverURL != url {
                serverURL = url
                startTimer?.invalidate()
                webView.load(URLRequest(url: url))
            }
        }
    }

    static let pythonHelp = """
    Agent Builder работает на Python 3. Он входит в «Инструменты командной строки» Apple \
    (их же ставит git). Откройте Терминал и выполните:

        xcode-select --install

    Дождитесь окончания установки и снова откройте Agent Builder.
    """

    func serverExited(_ process: Process) {
        if quitting || process !== server { return }
        if !ownsServer && serverURL != nil { return }  // пользуемся уже запущенным — всё в порядке
        let tail = logTail()
        // /usr/bin/python3 без Command Line Tools — лишь заглушка, которая просит их установить.
        let noTools = ["xcode-select", "xcrun", "developer tools", "CommandLineTools"].contains { tail.contains($0) }
        if noTools && serverURL == nil {
            return fail("Нужен Python 3", Self.pythonHelp + "\n\nmacOS могла уже показать окно установки — согласитесь в нём.")
        }
        fail("Сервер конструктора остановился", tail + "\n\nНажмите ⌘R, чтобы запустить его снова.")
    }

    func openLog() {
        try? FileManager.default.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }
        log = FileHandle(forWritingAtPath: logPath)
        log?.seekToEndOfFile()
    }

    func logTail() -> String {
        guard let text = try? String(contentsOfFile: logPath, encoding: .utf8) else { return "" }
        return String(text.suffix(1500))
    }

    // MARK: страницы-заглушки

    func showMessage(_ title: String, detail: String? = nil, error: Bool = false) {
        func esc(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        }
        let html = """
        <!doctype html><meta charset="utf-8"><style>
        :root { color-scheme: light dark; }
        body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
               font: 15px -apple-system, sans-serif; background: Canvas; color: CanvasText; }
        .box { text-align: center; max-width: 620px; padding: 24px; }
        h1 { font-size: 18px; margin: 16px 0 10px; }
        pre { text-align: left; white-space: pre-wrap; font: 12px ui-monospace, monospace; opacity: .85;
              background: rgba(127,127,127,.12); padding: 12px; border-radius: 10px; }
        .spin { width: 30px; height: 30px; margin: auto; border-radius: 50%;
                border: 3px solid rgba(127,127,127,.25); border-top-color: #ff7b3d; animation: s .8s linear infinite; }
        .err { font-size: 30px; }
        @keyframes s { to { transform: rotate(360deg); } }
        </style>
        <div class="box">\(error ? "<div class=err>⚠︎</div>" : "<div class=spin></div>")
        <h1>\(esc(title))</h1>\(detail.map { "<pre>\(esc($0))</pre>" } ?? "")</div>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func fail(_ title: String, _ detail: String?) {
        startTimer?.invalidate()
        showMessage(title, detail: detail, error: true)
    }

    // MARK: WebKit

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Всё, что не сам конструктор, открываем в обычном браузере.
        if let url = action.request.url, let host = url.host,
           !["127.0.0.1", "localhost"].contains(host), ["http", "https"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Самопроверка при сборке: AGENT_BUILDER_SNAPSHOT=файл.png сохраняет снимок окна.
        guard let path = ProcessInfo.processInfo.environment["AGENT_BUILDER_SNAPSHOT"],
              webView.url?.host == serverURL?.host else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            webView.takeSnapshot(with: nil) { image, _ in
                if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                   let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: path))
                }
                if ProcessInfo.processInfo.environment["AGENT_BUILDER_SNAPSHOT_QUIT"] != nil { NSApp.terminate(nil) }
            }
        }
    }

    // MARK: меню

    @objc func reloadPage() {
        if let server = server, server.isRunning || (!ownsServer && serverURL != nil) {
            if let url = serverURL { webView.load(URLRequest(url: url)) } else { webView.reload() }
        } else {
            showMessage("Запускаю конструктор…")
            startServer()
        }
    }
    @objc func zoomIn() { webView.pageZoom = min(2.0, webView.pageZoom + 0.1) }
    @objc func zoomOut() { webView.pageZoom = max(0.5, webView.pageZoom - 0.1) }
    @objc func zoomReset() { webView.pageZoom = 1.0 }
    @objc func openFolder() {
        try? FileManager.default.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(URL(fileURLWithPath: dataDir))
    }

    func buildMenu() {
        let main = NSMenu()
        func item(_ title: String, _ action: Selector?, _ key: String = "",
                  _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let it = NSMenuItem(title: title, action: action, keyEquivalent: key)
            it.keyEquivalentModifierMask = mods
            return it
        }
        func menu(_ title: String, _ items: [NSMenuItem]) {
            let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }
            let holder = NSMenuItem()
            holder.submenu = m
            main.addItem(holder)
        }
        menu("Agent Builder", [
            item("О программе Agent Builder", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Показать данные в Finder", #selector(openFolder)),
            .separator(),
            item("Скрыть Agent Builder", #selector(NSApplication.hide(_:)), "h"),
            item("Скрыть остальные", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Показать все", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Завершить Agent Builder", #selector(NSApplication.terminate(_:)), "q"),
        ])
        menu("Правка", [
            item("Отменить", Selector(("undo:")), "z"),
            item("Повторить", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Вырезать", #selector(NSText.cut(_:)), "x"),
            item("Копировать", #selector(NSText.copy(_:)), "c"),
            item("Вставить", #selector(NSText.paste(_:)), "v"),
            item("Выбрать всё", #selector(NSText.selectAll(_:)), "a"),
        ])
        menu("Вид", [
            item("Перезагрузить", #selector(reloadPage), "r"),
            .separator(),
            item("Увеличить", #selector(zoomIn), "="),
            item("Уменьшить", #selector(zoomOut), "-"),
            item("Реальный размер", #selector(zoomReset), "0"),
            .separator(),
            item("Во весь экран", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        menu("Окно", [
            item("Свернуть", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Изменить масштаб окна", #selector(NSWindow.performZoom(_:))),
        ])
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
