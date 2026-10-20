import * as vscode from "vscode";
import type { MonitorController } from "../controller";
import type { FromWebview, ToWebview } from "./messages";

/**
 * Single-instance webview panel.
 * Lifecycle pattern adapted from copilot-agent-viz (MIT, https://github.com/ilyas-it83/copilot-agent-viz); see NOTICE.
 */
export class AgentMonitorPanel implements vscode.Disposable {
  static current: AgentMonitorPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, controller: MonitorController): void {
    if (AgentMonitorPanel.current) {
      AgentMonitorPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("copilotAgentMonitor", "Agent Monitor", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist"), vscode.Uri.joinPath(extensionUri, "media")],
    });
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
    AgentMonitorPanel.current = new AgentMonitorPanel(panel, extensionUri, controller);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly controller: MonitorController,
  ) {
    panel.webview.html = renderHtml(panel.webview, extensionUri);
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg)),
      controller.onDidChangeSnapshot((snapshot) => this.post({ type: "snapshot", snapshot })),
      controller.onDidChangeSessions(() => this.postSessions()),
    );
  }

  private onMessage(msg: FromWebview): void {
    switch (msg.type) {
      case "ready":
        this.postSessions();
        this.post({ type: "snapshot", snapshot: this.controller.snapshot() });
        return;
      case "selectSession":
        void this.controller.selectSession(msg.key);
        return;
      case "setFollow":
        this.controller.setFollow(msg.follow);
        return;
      case "reload":
        void this.controller.reload();
        return;
    }
  }

  private postSessions(): void {
    this.post({
      type: "sessions",
      sessions: this.controller.sessionOptions(),
      currentKey: this.controller.currentKey,
      follow: this.controller.follow,
    });
  }

  private post(msg: ToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  dispose(): void {
    AgentMonitorPanel.current = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.css"));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${style}" />
  <title>Agent Monitor</title>
</head>
<body>
  <header class="toolbar">
    <div class="session">
      <select id="session" aria-label="Session"></select>
      <label class="follow" title="Automatically switch to the most recently active session"><input type="checkbox" id="follow" /> Follow latest</label>
      <button id="reload" title="Reload this session from disk">Reload</button>
    </div>
    <div class="counts" id="counts"></div>
  </header>
  <div class="banner" id="banner" hidden></div>
  <main>
    <section class="graph" id="graph" aria-label="Agent graph">
      <div class="viewport" id="viewport">
        <svg id="edges" xmlns="http://www.w3.org/2000/svg"></svg>
        <div class="nodes" id="nodes"></div>
        <svg id="pulses" xmlns="http://www.w3.org/2000/svg"></svg>
      </div>
      <div class="graph-controls">
        <button id="zoomOut" title="Zoom out">−</button>
        <button id="zoomIn" title="Zoom in">+</button>
        <button id="fit" title="Fit graph to view">Fit</button>
      </div>
      <div class="legend">
        <span class="l-spawn">created</span>
        <span class="l-running">working</span>
        <span class="l-reuse">reused ↻</span>
        <span class="l-none">✉ follow-ups</span>
        <span class="l-peer">agent ↔ agent</span>
        <span class="l-replaced">new instead of reuse</span>
      </div>
      <div class="empty" id="empty" hidden></div>
    </section>
    <aside class="side">
      <section class="details" id="details" aria-live="polite"></section>
      <section class="feed-wrap">
        <h3>Activity</h3>
        <ol class="feed" id="feed"></ol>
      </section>
    </aside>
  </main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
