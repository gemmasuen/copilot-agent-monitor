export const RELEASE_REPO = "gemmasuen/copilot-agent-monitor";
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${RELEASE_REPO}/releases/download/`;

/** The subset of GitHub's "latest release" response this extension relies on. */
export interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

export interface AvailableUpdate {
  version: string;
  vsixName: string;
  vsixUrl: string;
  /** Lower-case hex SHA-256 of the VSIX, when GitHub reports one. */
  sha256?: string;
  releaseUrl: string;
}

type Version = [number, number, number];

export function parseVersion(text: string): Version | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] > b[i];
    }
  }
  return false;
}

/**
 * Returns the update offered by `release`, or undefined when it is not newer than
 * `currentVersion` or does not contain the expected VSIX asset from this repository.
 */
export function selectUpdate(
  release: GitHubRelease,
  currentVersion: string,
  extensionName: string,
): AvailableUpdate | undefined {
  if (release.draft === true || release.prerelease === true || typeof release.tag_name !== "string") {
    return undefined;
  }
  const parsed = parseVersion(release.tag_name);
  if (!parsed || !isNewerVersion(release.tag_name, currentVersion)) {
    return undefined;
  }
  const version = parsed.join(".");
  const vsixName = `${extensionName}-${version}.vsix`;
  const assets: unknown[] = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find(
    (a): a is { name: string; browser_download_url: string; digest?: unknown } =>
      typeof a === "object" &&
      a !== null &&
      (a as { name?: unknown }).name === vsixName &&
      typeof (a as { browser_download_url?: unknown }).browser_download_url === "string",
  );
  if (!asset || !asset.browser_download_url.startsWith(DOWNLOAD_PREFIX)) {
    return undefined;
  }
  const digest = typeof asset.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest) : null;
  const releaseUrl =
    typeof release.html_url === "string" && release.html_url.startsWith(`https://github.com/${RELEASE_REPO}/`)
      ? release.html_url
      : `https://github.com/${RELEASE_REPO}/releases/latest`;
  return {
    version,
    vsixName,
    vsixUrl: asset.browser_download_url,
    sha256: digest ? digest[1].toLowerCase() : undefined,
    releaseUrl,
  };
}
