const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const SITE = !app.isPackaged && process.env.STARPUNCH_TEST_URL || 'https://starpunch-attendance.ewofts.chatgpt.site';
const origin = new URL(SITE).origin;
const userData = !app.isPackaged && process.env.STARPUNCH_TEST_DATA || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'StarPunchCloud');
app.setPath('userData', userData);
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  let win, machine;
  const offlineUrl = pathToFileURL(path.join(__dirname, 'offline.html')).href;
  const tokenPath = path.join(userData, 'device.bin');
  const validSender = (event, allowOffline = false) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('访问被拒绝');
    const url = event.senderFrame.url;
    if (allowOffline && url === offlineUrl) return;
    if (new URL(url).origin !== origin) throw new Error('访问被拒绝');
  };
  const readToken = () => {
    try {
      const stored = JSON.parse(safeStorage.decryptString(fs.readFileSync(tokenPath)));
      return stored.machineId === machine.id ? stored.token : '';
    } catch { return ''; }
  };
  async function openSite() {
    try { await win.loadURL(SITE); } catch { if (!win.isDestroyed()) await win.loadFile('offline.html'); }
  }
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    try {
      const raw = execFileSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], { encoding: 'utf8', windowsHide: true });
      const guid = raw.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
      if (!guid) throw new Error('无法读取本机标识');
      machine = { id: crypto.createHash('sha256').update('StarPunchCloud:v2:' + guid.toLowerCase()).digest('hex'), name: os.hostname() };
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用');
      fs.mkdirSync(userData, { recursive: true });
      ipcMain.handle('device:machine', event => { validSender(event); return machine; });
      ipcMain.handle('device:get', event => { validSender(event); return readToken(); });
      ipcMain.handle('device:store', (event, token) => {
        validSender(event);
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('绑定凭据格式不正确');
        fs.writeFileSync(tokenPath + '.tmp', safeStorage.encryptString(JSON.stringify({ machineId: machine.id, token })));
        fs.renameSync(tokenPath + '.tmp', tokenPath);
      });
      ipcMain.handle('device:clear', event => { validSender(event); fs.rmSync(tokenPath, { force: true }); });
      ipcMain.handle('device:retry', event => { validSender(event, true); return openSite(); });
      win = new BrowserWindow({ width: 1280, height: 860, minWidth: 960, minHeight: 680, title: '星光打卡', icon: path.join(__dirname, 'icon.ico'), backgroundColor: '#0c0b1b', show: false,
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
      win.removeMenu(); win.once('ready-to-show', () => win.show());
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin || new URL(url).pathname.startsWith('/admin')) event.preventDefault(); });
      win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      await openSite(); win.show();
    } catch (error) { dialog.showErrorBox('星光打卡启动失败', error.message + '\n请保留此提示并联系管理员。'); app.quit(); }
  });
  app.on('window-all-closed', () => app.quit());
}
