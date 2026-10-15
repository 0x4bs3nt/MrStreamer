// Metro bundles the shared packages from source. They are not installed here, so their own
// imports (arktype, effect) are resolved as if this app had made them: one copy of each, the
// version this app's lockfile holds, on the workbench and on the Mac alike.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const packages = path.resolve(__dirname, "../../packages");
const fromApp = path.join(__dirname, "index.ts");

config.watchFolders = [...config.watchFolders, packages];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const bare = !moduleName.startsWith(".") && !path.isAbsolute(moduleName);
  const shared = context.originModulePath.startsWith(packages + path.sep);
  return context.resolveRequest(
    bare && shared ? { ...context, originModulePath: fromApp } : context,
    moduleName,
    platform,
  );
};

module.exports = config;
