// Module Federation remote exposing the config panel (signalk-container-
// helper README "Config-panel UI"). This package is ESM ("type": "module"
// in package.json), so the Admin UI loads this with a dynamic import() and
// needs a real ESM container -- `library: { type: "module" }`, not the
// classic `var` remote the README warns fails silently for ESM plugins.
//
// No ts-loader/babel-loader here: `npm run build` (tsc) already compiles
// src/configpanel/PluginConfigurationPanel.tsx to plain
// dist/configpanel/PluginConfigurationPanel.js (React.createElement calls,
// tsconfig.json already has "jsx": "react" and DOM lib configured) before
// this runs, so webpack only ever bundles already-compiled JS.
const path = require("path");
const { ModuleFederationPlugin } = require("webpack").container;

module.exports = {
  mode: "production",
  entry: {},
  experiments: { outputModule: true },
  output: {
    path: path.resolve(__dirname, "public"),
    module: true,
    // Preserves public/index.html (the signalk-webapp redirect shim,
    // ARCHITECTURE.md §7) -- both live in the same directory since
    // signalk-server's static webapp mount serves this whole folder.
    clean: false,
  },
  plugins: [
    new ModuleFederationPlugin({
      name: "signalk_jukebox",
      library: { type: "module" },
      filename: "remoteEntry.js",
      exposes: {
        "./PluginConfigurationPanel":
          "./dist/configpanel/PluginConfigurationPanel.js",
      },
      shared: {
        react: { singleton: true, requiredVersion: "^19" },
      },
    }),
  ],
};
