const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("CFG", {
    appName: "chatgpt-fighter",
    version: "1.0.0"
});