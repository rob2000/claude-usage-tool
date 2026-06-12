import { app, BrowserWindow, ipcMain, Tray, nativeImage, Menu, screen, dialog } from 'electron';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { scrapeClaudeUsage, scrapeBillingInfo, openLoginWindow, openPlatformLoginWindow, isAuthenticated } from './scraper';
import { getUsageReport, getCostReport, getCreditBalance, ApiData } from './adminApi';

// Disable default error dialogs in production
if (app.isPackaged) {
  dialog.showErrorBox = () => {};
}

// Handle uncaught exceptions to prevent crashes from EPIPE errors
process.on('uncaughtException', (error) => {
  // Ignore EPIPE errors which occur when writing to closed pipes
  if (error.message?.includes('EPIPE')) {
    return;
  }
  // In dev mode, log to console; in prod, silently ignore non-critical errors
  if (!app.isPackaged) {
    console.error('Uncaught exception:', error);
  }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message?.includes('EPIPE')) {
    return;
  }
  if (!app.isPackaged) {
    console.error('Unhandled rejection:', reason);
  }
});

// Load environment variables - try multiple paths
const envPaths = [
  path.join(__dirname, '..', '.env.local'),
  path.join(app.getAppPath(), '.env.local'),
  path.join(process.cwd(), '.env.local'),
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    console.log('Loading .env.local from:', envPath);
    dotenv.config({ path: envPath });
    break;
  }
}

console.log('Admin key configured:', !!process.env.ANTHROPIC_ADMIN_KEY);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let refreshInterval: NodeJS.Timeout | null = null;

const isDev = !app.isPackaged;

// Activity log system - keep last 20 entries
interface LogEntry {
  timestamp: string;
  message: string;
}
const activityLogs: LogEntry[] = [];
const MAX_LOGS = 20;

function addLog(message: string) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    message
  };
  activityLogs.push(entry);
  if (activityLogs.length > MAX_LOGS) {
    activityLogs.shift();
  }
  console.log(`[${entry.timestamp}] ${message}`);
}

function getRecentLogs(count: number = 6): LogEntry[] {
  return activityLogs.slice(-count);
}

function createWindow() {
  const isLinux = process.platform === 'linux';
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    transparent: !isLinux,
    backgroundColor: isLinux ? '#1a1a1a' : undefined,
    type: isLinux ? 'toolbar' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // In production, __dirname is inside app.asar/dist-electron
    // So we need to go up one level to get to dist/index.html
    const htmlPath = path.join(__dirname, '..', 'dist', 'index.html');
    console.log('Loading HTML from:', htmlPath);
    mainWindow.loadFile(htmlPath);
  }

  mainWindow.on('blur', () => {
    mainWindow?.hide();
  });
}

async function tintIconClaudeOrange(srcPath: string): Promise<Electron.NativeImage | null> {
  // Re-color the template silhouette to Claude orange (#d97706) while
  // preserving the source's alpha mask (= original icon shape).
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(srcPath).metadata();
    const width = meta.width ?? 32;
    const height = meta.height ?? 32;
    const alpha = await sharp(srcPath).extractChannel('alpha').raw().toBuffer();
    const tinted = await sharp({
      create: { width, height, channels: 3, background: { r: 217, g: 119, b: 6 } },
    })
      .joinChannel(alpha, { raw: { width, height, channels: 1 } })
      .png()
      .toBuffer();
    return nativeImage.createFromBuffer(tinted);
  } catch (err) {
    console.error('Tray icon tint failed:', err);
    return null;
  }
}

async function createTray() {
  const isLinux = process.platform === 'linux';
  const iconPath = path.join(
    __dirname,
    '..',
    'assets',
    isLinux ? 'trayIconTemplate@2x.png' : 'trayIconTemplate.png'
  );
  let icon: Electron.NativeImage;

  try {
    if (isLinux) {
      // Linux StatusNotifier doesn't auto-invert template images — tint to
      // Claude orange so it stays visible against any panel background.
      const tinted = await tintIconClaudeOrange(iconPath);
      icon = tinted ?? nativeImage.createFromPath(iconPath);
    } else {
      icon = nativeImage.createFromPath(iconPath);
    }
    if (icon.isEmpty()) {
      icon = nativeImage.createEmpty();
    }
  } catch {
    icon = nativeImage.createEmpty();
  }

  // If icon is empty, create a basic one programmatically
  if (icon.isEmpty()) {
    // Create a 16x16 basic icon
    const size = 16;
    const canvas = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      canvas[i * 4] = 100;     // R
      canvas[i * 4 + 1] = 100; // G
      canvas[i * 4 + 2] = 100; // B
      canvas[i * 4 + 3] = 255; // A
    }
    icon = nativeImage.createFromBuffer(canvas, { width: size, height: size });
  }

  tray = new Tray(icon);
  tray.setToolTip('Claude Usage Tool');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Refresh', click: () => refreshAllData() },
    { label: 'Login to Claude', click: () => openLoginWindow() },
    { type: 'separator' },
    {
      label: 'About',
      click: () => {
        const aboutWindow = new BrowserWindow({
          width: 300,
          height: 200,
          resizable: false,
          minimizable: false,
          maximizable: false,
          title: 'About Claude Usage Tool',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        });

        const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
        const iconBase64 = fs.existsSync(iconPath)
          ? 'data:image/png;base64,' + fs.readFileSync(iconPath).toString('base64')
          : '';

        const html = `
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100vh;
                margin: 0;
                background: #1a1a1a;
                color: #fff;
                text-align: center;
                -webkit-user-select: none;
              }
              img { width: 64px; height: 64px; margin-bottom: 12px; }
              h1 { font-size: 16px; margin: 0 0 4px 0; font-weight: 600; }
              .version { font-size: 12px; color: #888; margin-bottom: 8px; }
              .author { font-size: 12px; color: #aaa; }
              a { color: #d97706; text-decoration: none; }
              a:hover { text-decoration: underline; }
            </style>
          </head>
          <body>
            <img src="${iconBase64}" alt="icon" />
            <h1>Claude Usage Tool</h1>
            <div class="version">ver 0.10</div>
            <div class="author">by <a href="mailto:kingi@kingigilbert.com">Kingi Gilbert</a></div>
          </body>
          </html>
        `;

        aboutWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        aboutWindow.setMenu(null);
      }
    },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      showWindow();
    }
  });

  tray.on('right-click', () => {
    tray?.popUpContextMenu(contextMenu);
  });

  // Linux AppIndicators don't fire 'click' — bind the menu so left-click works,
  // and prepend an entry to open the popup window.
  if (process.platform === 'linux') {
    const linuxMenu = Menu.buildFromTemplate([
      { label: 'Open', click: () => showWindow() },
      { type: 'separator' },
      ...contextMenu.items.map(item => item),
    ]);
    tray.setContextMenu(linuxMenu);
  }
}

function showWindow() {
  if (!mainWindow || !tray) {
    console.log('showWindow: mainWindow or tray is null');
    return;
  }

  const trayBounds = tray.getBounds();
  const windowBounds = mainWindow.getBounds();

  console.log('Tray bounds:', trayBounds);
  console.log('Window bounds:', windowBounds);

  // On Linux, tray.getBounds() returns zeros — anchor to the cursor instead,
  // which is reliably near the tray icon at click time.
  const useCursorAnchor =
    process.platform === 'linux' ||
    (trayBounds.width === 0 && trayBounds.height === 0);

  let anchor: { x: number; y: number };
  if (useCursorAnchor) {
    anchor = screen.getCursorScreenPoint();
  } else {
    anchor = {
      x: trayBounds.x + trayBounds.width / 2,
      y: trayBounds.y + trayBounds.height,
    };
  }

  const display = screen.getDisplayNearestPoint(anchor);
  const workArea = display.workArea;
  console.log('Anchor:', anchor, 'WorkArea:', workArea);

  let x = Math.round(anchor.x - windowBounds.width / 2);
  let y: number;
  if (useCursorAnchor) {
    // Snap to the top or bottom of the work area depending on where the
    // panel sits (panel at top → workArea.y > display.bounds.y).
    const panelAtTop = workArea.y > display.bounds.y;
    y = panelAtTop
      ? workArea.y + 4
      : workArea.y + workArea.height - windowBounds.height - 4;
  } else {
    y = Math.round(anchor.y + 4);
  }

  // Clamp to work area
  if (x + windowBounds.width > workArea.x + workArea.width) {
    x = workArea.x + workArea.width - windowBounds.width;
  }
  if (x < workArea.x) {
    x = workArea.x;
  }

  mainWindow.setPosition(x, y, false);
  mainWindow.show();
  mainWindow.focus();
}

async function refreshAllData() {
  if (!mainWindow) return;

  addLog('Refreshing data...');

  try {
    const [claudeUsage, billingInfo] = await Promise.all([
      scrapeClaudeUsage().then(result => {
        if (result) {
          if (result.isAuthenticated) {
            addLog(`Usage: ${result.bars?.length || 0} bars fetched`);
          } else {
            addLog('Usage: Not authenticated');
          }
        } else {
          addLog('Usage: Skipped (in progress)');
        }
        return result;
      }).catch(err => {
        addLog(`Usage error: ${err.message}`);
        return null;
      }),
      scrapeBillingInfo().then(result => {
        if (result) {
          if (result.creditBalance !== null) {
            addLog(`Billing: $${result.creditBalance.toFixed(2)}`);
          } else {
            addLog('Billing: No balance data');
          }
        } else {
          addLog('Billing: Skipped (in progress)');
        }
        return result;
      }).catch(err => {
        addLog(`Billing error: ${err.message}`);
        return null;
      }),
    ]);

    mainWindow.webContents.send('app:data-updated', {
      claudeUsage,
      billingInfo,
      timestamp: new Date().toISOString(),
      logs: getRecentLogs(6),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addLog(`Refresh failed: ${message}`);
  }
}

async function getApiData(): Promise<ApiData | null> {
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  console.log('getApiData called, key exists:', !!adminKey);
  console.log('Key starts with sk-ant-admin:', adminKey?.startsWith('sk-ant-admin'));
  console.log('Key prefix:', adminKey?.substring(0, 20));

  if (!adminKey) {
    console.log('Admin key not configured');
    return null;
  }

  // Accept both sk-ant-admin- and sk-ant-admin01- prefixes
  if (!adminKey.startsWith('sk-ant-admin')) {
    console.log('Invalid admin key format');
    return null;
  }

  const now = new Date();
  // Use a date from 30 days ago to now - using simple date strings
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const startDate = thirtyDaysAgo.toISOString().split('T')[0] + 'T00:00:00Z';
  const endDateStr = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0] + 'T00:00:00Z';

  try {
    console.log('Fetching API data from:', startDate, 'to:', endDateStr);

    const [usageReport, costReport, creditBalance] = await Promise.all([
      getUsageReport(adminKey, {
        starting_at: startDate,
        group_by: ['workspace_id', 'model'],
        limit: 31,
      }),
      getCostReport(adminKey, {
        starting_at: startDate,
        group_by: ['workspace_id'],
        limit: 31,
      }),
      getCreditBalance(adminKey).catch(err => {
        console.log('Credit balance not available:', err.message);
        return null;
      }),
    ]);

    console.log('API data fetched successfully');
    console.log('Usage buckets:', usageReport?.data?.length || 0);
    console.log('Cost buckets:', costReport?.data?.length || 0);
    console.log('Credit balance:', creditBalance?.available_credit || 'N/A');

    return { usageReport, costReport, creditBalance };
  } catch (error) {
    console.error('Error fetching API data:', error);
    throw error;
  }
}

function startAutoRefresh() {
  // Refresh every 60 seconds
  refreshInterval = setInterval(refreshAllData, 60000);
  // Initial refresh
  refreshAllData();
}

// IPC Handlers
ipcMain.handle('claude-max:get-usage', async () => {
  try {
    return await scrapeClaudeUsage();
  } catch (error) {
    console.error('Failed to get Claude usage:', error);
    return null;
  }
});

ipcMain.handle('claude-max:is-authenticated', async () => {
  return isAuthenticated();
});

ipcMain.handle('claude-max:login', async () => {
  return openLoginWindow();
});

ipcMain.handle('platform:login', async () => {
  return openPlatformLoginWindow();
});

ipcMain.handle('app:refresh-all', async () => {
  await refreshAllData();
});

ipcMain.handle('app:get-admin-key-status', () => {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  return {
    configured: !!key && key.startsWith('sk-ant-admin'),
    hint: key ? `${key.substring(0, 15)}...` : null,
  };
});

// App lifecycle
app.whenReady().then(async () => {
  createWindow();
  await createTray();
  startAutoRefresh();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});

// Hide dock icon on macOS (menu bar app)
if (process.platform === 'darwin') {
  app.dock?.hide();
}
