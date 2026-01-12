import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
    app.quit();
}

async function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 980,
        minHeight: 680,
        backgroundColor: '#0b0f1a',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    win.setMenuBarVisibility(false);

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        await win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
        win.webContents.openDevTools({ mode: 'detach' });
    } else {
        await win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
    }
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});