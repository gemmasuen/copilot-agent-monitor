import * as vscode from "vscode";
import { MonitorConfig, MonitorController } from "./controller";
import { formatAgo } from "./model/format";
import { SessionSnapshot } from "./model/snapshot";
import { defaultCopilotSessionStateDir, vscodeWorkspaceStorageDirs } from "./sources/discovery";
import { AgentMonitorPanel } from "./webview/panel";

const SECTION = "copilotAgentMonitor";

function readConfig(): MonitorConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const override = cfg.get<string>("copilotSessionStateDir", "").trim();
  return {
    copilotSessions: cfg.get<boolean>("sources.copilotSessions", true),
    vscodeTranscripts: cfg.get<boolean>("sources.vscodeTranscripts", true),
    copilotStateDir: override || defaultCopilotSessionStateDir(),
    vscodeStorageDirs: vscodeWorkspaceStorageDirs(),
    showPreviews: cfg.get<boolean>("showPreviews", true),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new MonitorController(readConfig());
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = `${SECTION}.open`;
  context.subscriptions.push(controller, statusBar);

  const updateStatusBar = (snap: SessionSnapshot | undefined) => {
    if (!vscode.workspace.getConfiguration(SECTION).get<boolean>("statusBar", true) || !snap) {
      statusBar.hide();
      return;
    }
    const { running, idle, done, failed } = snap.counts;
    const icon = running > 0 ? "$(sync~spin)" : "$(type-hierarchy)";
    const total = running + idle + done + failed;
    statusBar.text = total === 0 ? `${icon} Agents` : `${icon} ${running} running · ${idle} idle`;
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendText(`${snap.title}\n\n`);
    tip.appendMarkdown(
      `**Sub-agents:** ${running} running · ${idle} idle (reusable) · ${done} done${failed ? ` · ${failed} failed` : ""}\n\n`,
    );
    tip.appendMarkdown("Click to open the Agent Monitor");
    statusBar.tooltip = tip;
    statusBar.show();
  };
  context.subscriptions.push(controller.onDidChangeSnapshot(updateStatusBar));

  context.subscriptions.push(
    vscode.commands.registerCommand(`${SECTION}.open`, () => AgentMonitorPanel.show(context.extensionUri, controller)),
    vscode.commands.registerCommand(`${SECTION}.selectSession`, async () => {
      await controller.discover();
      const now = Date.now();
      const items = controller.sessionInfos().map((s) => ({
        label: s.title,
        description: `${s.source === "copilot" ? "Copilot" : "VS Code"} · ${formatAgo(now - s.mtimeMs)}`,
        detail: s.cwd,
        key: s.key,
        picked: s.key === controller.currentKey,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        title: "Monitor which agent session?",
        placeHolder: "Sessions, most recently active first",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (pick) {
        await controller.selectSession(pick.key);
        AgentMonitorPanel.show(context.extensionUri, controller);
      }
    }),
    vscode.commands.registerCommand(`${SECTION}.followLatest`, () => {
      controller.setFollow(true);
      AgentMonitorPanel.show(context.extensionUri, controller);
    }),
    vscode.commands.registerCommand(`${SECTION}.refresh`, () => controller.reload()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        void controller.updateConfig(readConfig());
        updateStatusBar(controller.snapshot());
      }
    }),
  );

  void controller.start();
}

export function deactivate(): void {
  // Disposables registered on the context are cleaned up by VS Code.
}
