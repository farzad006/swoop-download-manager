import { defineConfig } from "wxt";
import keyFile from "./extension-key.json";

// Chromium builds embed a fixed public key so the extension ID stays
// `fhnkijclhenhpkpllphcclallnnkkiib` wherever it's loaded unpacked; the
// native-messaging host only accepts that ID.
export default defineConfig({
  manifest: ({ browser }) => ({
    name: "Swoop",
    description: "Sends downloads and web videos to Swoop, the download manager by Ali Studio.",
    version: "1.0.6",
    permissions: ["downloads", "nativeMessaging", "cookies", "webRequest", "contextMenus", "storage", "tabs"],
    host_permissions: ["<all_urls>"],
    icons: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 128: "icon/128.png" },
    action: { default_title: "Swoop" },
    ...(browser === "firefox"
      ? { browser_specific_settings: { gecko: { id: "swoop@alistudio", strict_min_version: "140.0", data_collection_permissions: { required: ["none"] } } } }
      : { key: keyFile.key }),
  }),
});
