const MIN_SUPPORTED_NODE_MAJOR = 20;

export function getNodeMajorVersion(version = process.versions.node): number {
  const match = /^(\d+)\./.exec(version);
  return match ? parseInt(match[1] ?? "", 10) : Number.NaN;
}

export function getUnsupportedNodeMessage(version = process.versions.node): string | null {
  const major = getNodeMajorVersion(version);
  if (!Number.isFinite(major) || major >= MIN_SUPPORTED_NODE_MAJOR) return null;
  return [
    `Unsupported Node.js runtime ${version}.`,
    `@e2b/code-interpreter and e2b require Node ${MIN_SUPPORTED_NODE_MAJOR}+ in this gateway/verifier path.`,
    "Running on older Node versions can break python_tests verification with ERR_REQUIRE_ESM via chalk/e2b.",
    `Upgrade the gateway runtime to Node ${MIN_SUPPORTED_NODE_MAJOR}+ and restart.`,
  ].join(" ");
}

export function assertSupportedNodeRuntime(version = process.versions.node): void {
  const message = getUnsupportedNodeMessage(version);
  if (message) throw new Error(message);
}

