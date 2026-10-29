import { createHash } from "crypto";
import * as vscode from "vscode";
import { AvailableUpdate, GitHubRelease, LATEST_RELEASE_API, selectUpdate } from "./releases";

const SECTION = "copilotAgentMonitor";
const LAST_CHECK_KEY = "update.lastCheckMs";
const SKIPPED_KEY = "update.skippedVersion";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_VSIX_BYTES = 50 * 1024 * 1024;

type CheckResult = { kind: "update"; update: AvailableUpdate } | { kind: "current" } | { kind: "error"; message: string };

export function registerUpdateChecks(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(`${SECTION}.checkForUpdates`, () => checkForUpdates(context, true)),
  );

  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    return;
  }
  const timer = setTimeout(() => {
    const enabled = vscode.workspace.getConfiguration(SECTION).get<boolean>("checkForUpdates", true);
    const last = context.globalState.get<number>(LAST_CHECK_KEY, 0);
    if (enabled && Date.now() - last >= CHECK_INTERVAL_MS) {
      void checkForUpdates(context, false);
    }
  }, STARTUP_DELAY_MS);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}

async function checkForUpdates(context: vscode.ExtensionContext, manual: boolean): Promise<void> {
  const current = String(context.extension.packageJSON.version);
  const result = await fetchLatest(current, String(context.extension.packageJSON.name));
  await context.globalState.update(LAST_CHECK_KEY, Date.now());

  if (result.kind === "error") {
    if (manual) {
      void vscode.window.showWarningMessage(`Couldn't check for Copilot Agent Monitor updates: ${result.message}`);
    }
    return;
  }
  if (result.kind === "current") {
    if (manual) {
      void vscode.window.showInformationMessage(`Copilot Agent Monitor ${current} is the latest version.`);
    }
    return;
  }

  const { update } = result;
  if (!manual && context.globalState.get<string>(SKIPPED_KEY) === update.version) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Copilot Agent Monitor ${update.version} is available. You have ${current}.`,
    "Update",
    "Release Notes",
    "Skip This Version",
  );
  if (choice === "Update") {
    await installUpdate(context, update);
  } else if (choice === "Release Notes") {
    void vscode.env.openExternal(vscode.Uri.parse(update.releaseUrl));
  } else if (choice === "Skip This Version") {
    await context.globalState.update(SKIPPED_KEY, update.version);
  }
}

async function fetchLatest(currentVersion: string, extensionName: string): Promise<CheckResult> {
  try {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `${extensionName}/${currentVersion}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) {
      return { kind: "current" };
    }
    if (!res.ok) {
      return { kind: "error", message: `GitHub responded with ${res.status}.` };
    }
    const update = selectUpdate((await res.json()) as GitHubRelease, currentVersion, extensionName);
    return update ? { kind: "update", update } : { kind: "current" };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

async function installUpdate(context: vscode.ExtensionContext, update: AvailableUpdate): Promise<void> {
  const dir = vscode.Uri.joinPath(context.globalStorageUri, "updates");
  const file = vscode.Uri.joinPath(dir, update.vsixName);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Updating Copilot Agent Monitor to ${update.version}…` },
      async () => {
        const bytes = await download(update);
        await vscode.workspace.fs.createDirectory(dir);
        await vscode.workspace.fs.writeFile(file, bytes);
        await vscode.commands.executeCommand("workbench.extensions.installExtension", file);
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const choice = await vscode.window.showErrorMessage(
      `Couldn't update Copilot Agent Monitor: ${message}`,
      "Open Release Page",
    );
    if (choice) {
      void vscode.env.openExternal(vscode.Uri.parse(update.releaseUrl));
    }
    return;
  } finally {
    await vscode.workspace.fs.delete(file, { useTrash: false }).then(undefined, () => undefined);
  }

  const restart = await vscode.window.showInformationMessage(
    `Copilot Agent Monitor ${update.version} is installed. Restart extensions to use it.`,
    "Restart Extensions",
  );
  if (restart) {
    await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
  }
}

async function download(update: AvailableUpdate): Promise<Uint8Array> {
  const res = await fetch(update.vsixUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4) });
  if (!res.ok) {
    throw new Error(`download failed (${res.status})`);
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_VSIX_BYTES) {
    throw new Error("the download is unexpectedly large");
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_VSIX_BYTES) {
    throw new Error("the download is unexpectedly large");
  }
  if (update.sha256 && createHash("sha256").update(bytes).digest("hex") !== update.sha256) {
    throw new Error("the downloaded file doesn't match the release checksum");
  }
  return bytes;
}
