import { describe, expect, it } from "vitest";
import { GitHubRelease, isNewerVersion, parseVersion, selectUpdate } from "../src/update/releases";

const NAME = "copilot-agent-monitor";
const DOWNLOAD = "https://github.com/gemmasuen/copilot-agent-monitor/releases/download";
const DIGEST = "a".repeat(64);

function release(overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    tag_name: "v0.2.0",
    html_url: "https://github.com/gemmasuen/copilot-agent-monitor/releases/tag/v0.2.0",
    draft: false,
    prerelease: false,
    assets: [
      { name: "notes.txt", browser_download_url: `${DOWNLOAD}/v0.2.0/notes.txt` },
      {
        name: `${NAME}-0.2.0.vsix`,
        browser_download_url: `${DOWNLOAD}/v0.2.0/${NAME}-0.2.0.vsix`,
        digest: `sha256:${DIGEST.toUpperCase()}`,
      },
    ],
    ...overrides,
  };
}

describe("versions", () => {
  it("parses plain and v-prefixed semantic versions", () => {
    expect(parseVersion("0.1.1")).toEqual([0, 1, 1]);
    expect(parseVersion("v10.2.3")).toEqual([10, 2, 3]);
    expect(parseVersion("1.2")).toBeUndefined();
    expect(parseVersion("1.2.3-beta.1")).toBeUndefined();
  });

  it("compares numerically, not lexically", () => {
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("v1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.1.1", "0.1.1")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(false);
    expect(isNewerVersion("garbage", "0.1.0")).toBe(false);
  });
});

describe("selectUpdate", () => {
  it("offers the matching VSIX from a newer release", () => {
    expect(selectUpdate(release(), "0.1.1", NAME)).toEqual({
      version: "0.2.0",
      vsixName: `${NAME}-0.2.0.vsix`,
      vsixUrl: `${DOWNLOAD}/v0.2.0/${NAME}-0.2.0.vsix`,
      sha256: DIGEST,
      releaseUrl: "https://github.com/gemmasuen/copilot-agent-monitor/releases/tag/v0.2.0",
    });
  });

  it("ignores releases that are not newer", () => {
    expect(selectUpdate(release(), "0.2.0", NAME)).toBeUndefined();
    expect(selectUpdate(release(), "0.3.0", NAME)).toBeUndefined();
  });

  it("ignores drafts, pre-releases and malformed tags", () => {
    expect(selectUpdate(release({ draft: true }), "0.1.0", NAME)).toBeUndefined();
    expect(selectUpdate(release({ prerelease: true }), "0.1.0", NAME)).toBeUndefined();
    expect(selectUpdate(release({ tag_name: "latest" }), "0.1.0", NAME)).toBeUndefined();
    expect(selectUpdate(release({ tag_name: 2 }), "0.1.0", NAME)).toBeUndefined();
  });

  it("requires a VSIX named for the release version", () => {
    const assets = [{ name: `${NAME}-0.1.9.vsix`, browser_download_url: `${DOWNLOAD}/v0.2.0/${NAME}-0.1.9.vsix` }];
    expect(selectUpdate(release({ assets }), "0.1.0", NAME)).toBeUndefined();
    expect(selectUpdate(release({ assets: undefined }), "0.1.0", NAME)).toBeUndefined();
  });

  it("rejects downloads hosted outside this repository's releases", () => {
    const assets = [{ name: `${NAME}-0.2.0.vsix`, browser_download_url: `https://example.com/${NAME}-0.2.0.vsix` }];
    expect(selectUpdate(release({ assets }), "0.1.0", NAME)).toBeUndefined();
  });

  it("omits malformed digests and falls back to the latest-release page", () => {
    const assets = [
      { name: `${NAME}-0.2.0.vsix`, browser_download_url: `${DOWNLOAD}/v0.2.0/${NAME}-0.2.0.vsix`, digest: "md5:abc" },
    ];
    const update = selectUpdate(release({ assets, html_url: "https://example.com/" }), "0.1.0", NAME);
    expect(update?.sha256).toBeUndefined();
    expect(update?.releaseUrl).toBe("https://github.com/gemmasuen/copilot-agent-monitor/releases/latest");
  });
});
