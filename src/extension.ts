import * as path from "path";
import * as vscode from "vscode";
import { DEFAULT_TIMINGS, MonitorConfig, MonitorController } from "./controller";
import { formatAgo } from "./model/format";
import { SessionSnapshot } from "./model/snapshot";
import { ChatLinkResolver } from "./sources/chatLinks";
import { defaultCopilotSessionStateDir, vscodeWorkspaceStorageDirs } from "./sources/discovery";
import { registerUpdateChecks } from "./update/updater";
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

/**
 * Locates chat data for the running VS Code (stable, Insiders or portable) from this extension's own storage:
 * globalStorageUri is <userData>/User/globalStorage/<extension> (or <userData>/User/profiles/<id>/globalStorage/...
 * in a profile with its own state) and storageUri is <userData>/User/workspaceStorage/<hash>/<extension>
 * (undefined in an empty window). On desktop these are often vscode-userdata: URIs that map 1:1 onto disk paths.
 */
function createChatLinks(context: vscode.ExtensionContext): ChatLinkResolver {
  const fsPath = (uri: vscode.Uri | undefined) =>
    uri?.scheme === "file" || uri?.scheme === "vscode-userdata" ? uri.fsPath : undefined;
  const globalStorage = fsPath(context.globalStorageUri);
  const workspaceStorage = fsPath(context.storageUri);
  const userData = globalStorage ? userDataDir(globalStorage) : undefined;
  return new ChatLinkResolver({
    agentSessionDataDir: userData ? path.join(userData, "agentSessionData") : undefined,
    currentWorkspaceStorageDir: workspaceStorage ? path.dirname(workspaceStorage) : undefined,
    workspaceStorageRoots: vscodeWorkspaceStorageDirs(),
  });
}

/** The VS Code user data folder: the parent of the "User" folder that `storagePath` sits in. */
function userDataDir(storagePath: string): string | undefined {
  for (let dir = storagePath; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (path.basename(dir).toLowerCase() === "user") {
      return path.dirname(dir);
    }
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const chatLinks = createChatLinks(context);
  const controller = new MonitorController(readConfig(), DEFAULT_TIMINGS, Date.now, (info) => chatLinks.title(info));
  const showPanel = () => AgentMonitorPanel.show(context.extensionUri, controller, chatLinks);
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
    vscode.commands.registerCommand(`${SECTION}.open`, showPanel),
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
        showPanel();
      }
    }),
    vscode.commands.registerCommand(`${SECTION}.followLatest`, () => {
      controller.setFollow(true);
      showPanel();
    }),
    vscode.commands.registerCommand(`${SECTION}.refresh`, () => controller.reload()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        void controller.updateConfig(readConfig());
        updateStatusBar(controller.snapshot());
      }
    }),
  );

  registerUpdateChecks(context);
  void controller.start();
}

export function deactivate(): void {
  // Disposables registered on the context are cleaned up by VS Code.
}
