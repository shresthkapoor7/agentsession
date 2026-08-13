const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 6)) {
  throw new Error("agentsession requires Node.js 22.6.0 or newer.");
}
