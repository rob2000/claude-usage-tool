import { BrowserWindow, session } from 'electron';

export interface UsageBar {
  used: number;
  limit: number;
  percentage: number;
  label?: string;
  context?: string;
}

export interface ClaudeMaxUsage {
  standard: UsageBar;
  advanced: UsageBar;
  bars?: UsageBar[];
  resetDate: string | null;
  lastUpdated: string;
  isAuthenticated: boolean;
  plan?: string;
  email?: string;
}

export interface BillingInfo {
  creditBalance: number | null;
  currency: string;
  lastUpdated: string;
}

let scraperWindow: BrowserWindow | null = null;
let billingWindow: BrowserWindow | null = null;
let loginWindow: BrowserWindow | null = null;
let platformLoginWindow: BrowserWindow | null = null;
let isScrapingUsage = false;
let isScrapingBilling = false;
const CLAUDE_USAGE_URL = 'https://claude.ai/settings/usage';
const CLAUDE_BILLING_URL = 'https://platform.claude.com/settings/billing';
const CLAUDE_SESSION_NAME = 'claude-session';

function getSession() {
  return session.fromPartition(`persist:${CLAUDE_SESSION_NAME}`);
}

export async function isAuthenticated(): Promise<boolean> {
  const ses = getSession();
  const cookies = await ses.cookies.get({ domain: '.claude.ai' });
  // Check for various session cookies that indicate authentication
  const hasSession = cookies.some(c =>
    c.name === 'sessionKey' ||
    c.name === '__Secure-next-auth.session-token' ||
    c.name === 'lastActiveOrg' ||
    (c.name.includes('session') && c.value.length > 20)
  );
  console.log('Auth check - cookies found:', cookies.map(c => c.name).join(', '));
  console.log('Auth check - has session:', hasSession);
  return hasSession;
}

export async function scrapeClaudeUsage(): Promise<ClaudeMaxUsage | null> {
  // Prevent concurrent scrapes
  if (isScrapingUsage) {
    console.log('Usage scrape already in progress, skipping...');
    return null;
  }
  isScrapingUsage = true;
  console.log('Starting Claude usage scrape...');

  return new Promise((resolve) => {
    if (scraperWindow && !scraperWindow.isDestroyed()) {
      scraperWindow.close();
    }

    scraperWindow = new BrowserWindow({
      width: 1000,
      height: 800,
      show: false, // Set to true to debug
      webPreferences: {
        session: getSession(),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        console.log('Scraper timeout reached');
        resolved = true;
        isScrapingUsage = false;
        scraperWindow?.close();
        scraperWindow = null;
        resolve(null);
      }
    }, 30000);

    // Check for redirects to login page
    scraperWindow.webContents.on('did-navigate', (_, url) => {
      console.log('Navigation to:', url);
      if (url.includes('/login') || url.includes('/signup')) {
        console.log('Redirected to login - not authenticated');
        if (!resolved) {
          resolved = true;
          isScrapingUsage = false;
          clearTimeout(timeout);
          scraperWindow?.close();
          scraperWindow = null;
          resolve({
            standard: { used: 0, limit: 0, percentage: 0 },
            advanced: { used: 0, limit: 0, percentage: 0 },
            resetDate: null,
            lastUpdated: new Date().toISOString(),
            isAuthenticated: false,
          });
        }
      }
    });

    scraperWindow.webContents.on('did-finish-load', async () => {
      if (resolved) return;
      if (!scraperWindow || scraperWindow.isDestroyed()) return;

      const currentUrl = scraperWindow.webContents.getURL() || '';
      console.log('Page loaded:', currentUrl);

      // If we're on login page, user is not authenticated
      if (currentUrl.includes('/login') || currentUrl.includes('/signup')) {
        resolved = true;
        isScrapingUsage = false;
        clearTimeout(timeout);
        scraperWindow?.close();
        scraperWindow = null;
        resolve({
          standard: { used: 0, limit: 0, percentage: 0 },
          advanced: { used: 0, limit: 0, percentage: 0 },
          resetDate: null,
          lastUpdated: new Date().toISOString(),
          isAuthenticated: false,
        });
        return;
      }

      // Poll for the usage panel to render — SPA route may take a while to mount.
      // Look for any "% used" / "% verbraucht" marker before giving up.
      const pollStart = Date.now();
      const POLL_TIMEOUT = 15000;
      const POLL_INTERVAL = 500;
      while (Date.now() - pollStart < POLL_TIMEOUT) {
        if (resolved || !scraperWindow || scraperWindow.isDestroyed()) return;
        try {
          const ready = await scraperWindow.webContents.executeJavaScript(
            `/(\\d+)\\s*%\\s*(used|verbraucht|utilisé|usado|usati|使用)/i.test(document.body.innerText)`
          );
          if (ready) break;
        } catch {
          // window may have been disposed; loop will exit on next check
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
      }

      // Check again after waiting
      if (resolved || !scraperWindow || scraperWindow.isDestroyed()) return;

      try {
        const result = await scraperWindow.webContents.executeJavaScript(`
          (function() {
            // Note: avoid console.log here as it can cause EPIPE errors when window closes

            const usage = {
              bars: [],
              resetDate: null,
              isAuthenticated: true,
              rawText: '',
              plan: null,
              email: null
            };

            // Check if on login page
            if (window.location.href.includes('/login') ||
                window.location.href.includes('/signup') ||
                document.body.innerText.includes('Welcome back') && document.body.innerText.includes('Continue with')) {
              usage.isAuthenticated = false;
              return JSON.stringify(usage);
            }

            const text = document.body.innerText;
            // Capture the section around any % marker — that's where the usage data lives,
            // not the top 2000 chars (which on claude.ai is the sidebar of chat history).
            const pctIdx = text.search(/\\d+\\s*%/);
            if (pctIdx >= 0) {
              const start = Math.max(0, pctIdx - 400);
              const end = Math.min(text.length, pctIdx + 2000);
              usage.rawText = text.substring(start, end);
            } else {
              usage.rawText = text.substring(0, 2000);
            }

            // Parse the structured usage sections from Claude's settings page
            // The page structure is:
            // - Current session / Resets in X hr Y min / X% used
            // - All models / Resets Day Time / X% used
            // - Sonnet only / Resets Day Time / X% used
            // - Extra usage / Resets Month Day / X% used

            const lines = text.split('\\n').map(l => l.trim()).filter(l => l);

            // Define the section labels we're looking for
            const sectionLabels = [
              'Current session',
              'All models',
              'Sonnet only',
              'Extra usage',
              'Weekly limit',
              'Weekly limits',
              'Daily limit',
              'Monthly limit',
              'Standard',
              'Advanced',
              // German
              'Aktuelle Sitzung',
              'Aktuelle Session',
              'Alle Modelle',
              'Nur Sonnet',
              'Sonnet nur',
              'Zusätzliche Nutzung',
              'Wöchentliches Limit',
              'Wöchentliche Limits',
              'Tägliches Limit',
              'Monatliches Limit'
            ];

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];

              // Check if this line matches a section label (case insensitive)
              const isLabel = sectionLabels.some(label =>
                line.toLowerCase() === label.toLowerCase()
              );

              if (isLabel) {
                const label = line;
                let percentage = 0;
                let resetInfo = '';

                // Look at next few lines for reset info and percentage
                for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
                  const nextLine = lines[j];

                  // Look for "Resets ..." / "Zurücksetzung ..." pattern
                  const lowered = nextLine.toLowerCase();
                  if (lowered.startsWith('reset') || lowered.startsWith('zurücksetzung')) {
                    resetInfo = nextLine;
                  }

                  // Look for "X% used" pattern
                  const pctMatch = nextLine.match(/(\\d+)\\s*%\\s*(used|verbraucht|genutzt|verwendet)/i);
                  if (pctMatch) {
                    percentage = parseInt(pctMatch[1], 10);
                    break; // Found the percentage, stop looking
                  }
                }

                // Only add if we found meaningful data
                if (percentage >= 0 || resetInfo) {
                  // Skip "Weekly limits" header if we have individual models
                  const lcLine = line.toLowerCase();
                  if (lcLine === 'weekly limits' || lcLine === 'wöchentliche limits' || lcLine === 'wöchentliches limit') continue;
                  // Skip if no percentage was actually found (header-only entries like "Wöchentliche Limits")
                  if (percentage === 0 && !resetInfo) continue;

                  usage.bars.push({
                    value: percentage,
                    max: 100,
                    label: label,
                    resetInfo: resetInfo,
                    percentage: percentage
                  });
                }
              }
            }

            // Fallback: if no bars found, try to find percentages
            if (usage.bars.length === 0) {
              const percentMatches = text.matchAll(/(\\d+)\\s*%\\s*(used|verbraucht|genutzt|verwendet)/gi);
              let idx = 0;
              const defaultLabels = ['Current Session', 'All models', 'Sonnet only', 'Extra usage'];

              for (const match of percentMatches) {
                const pct = parseInt(match[1], 10);
                if (pct >= 0 && pct <= 100) {
                  const exists = usage.bars.some(b => Math.abs(b.percentage - pct) < 1);
                  if (!exists) {
                    const matchIndex = match.index || 0;
                    const contextStart = Math.max(0, matchIndex - 100);
                    const contextEnd = Math.min(text.length, matchIndex + 100);
                    const context = text.substring(contextStart, contextEnd);

                    const resetMatch = context.match(/Resets?[^\\n]*/i);

                    usage.bars.push({
                      value: pct,
                      max: 100,
                      label: defaultLabels[idx] || 'Usage ' + (idx + 1),
                      resetInfo: resetMatch ? resetMatch[0].trim() : '',
                      percentage: pct
                    });
                    idx++;
                  }
                }
              }
            }

            // Find general reset date as fallback
            const resetPatterns = [
              /Resets\\s+in\\s+(\\d+\\s*hr?\\s*\\d*\\s*min[^\\n]*)/i,
              /Resets\\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\\n]*/i,
              /resets?\\s*(?:on|in|:)?\\s*([A-Za-z]+\\s+\\d+)/i,
              /in\\s+(\\d+)\\s*days?/i
            ];

            for (const pattern of resetPatterns) {
              const match = text.match(pattern);
              if (match) {
                usage.resetDate = match[0].trim();
                break;
              }
            }

            // Try to extract plan name (Max, Pro, Team, Free, etc.)
            const planPatterns = [
              /Claude\\s+(Max|Pro|Team|Enterprise|Free)/i,
              /(Max|Pro|Team|Enterprise)\\s+Plan/i,
              /Plan:\\s*(Max|Pro|Team|Enterprise|Free)/i,
              // Plan badge rendered right next to the usage-limits header
              // ("Your usage limits  Team" / "Deine Nutzungslimits  Team").
              /(?:Your\\s+usage\\s+limits|Deine\\s+Nutzungslimits)[\\s\\S]{0,40}?\\b(Max|Team|Pro|Enterprise|Free)\\b/i,
              /\\b(Max|Team|Pro|Enterprise|Free)\\b[\\s\\S]{0,40}?(?:Your\\s+usage\\s+limits|Deine\\s+Nutzungslimits)/i
            ];
            for (const pattern of planPatterns) {
              const match = text.match(pattern);
              if (match) {
                usage.plan = match[1];
                break;
              }
            }

            // Try to extract email from the page
            const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/);
            if (emailMatch) {
              usage.email = emailMatch[0];
            }

            return JSON.stringify(usage);
          })();
        `);

        if (resolved) return;

        console.log('Usage scrape raw result:', result ? 'got data' : 'no data');

        if (result) {
          const parsed = JSON.parse(result);
          console.log('Parsed usage data - bars:', parsed.bars?.length, 'auth:', parsed.isAuthenticated);
          if (parsed.bars?.length) {
            console.log('Bars detail:', JSON.stringify(parsed.bars, null, 2));
          }
          if (!parsed.bars?.length && parsed.isAuthenticated) {
            console.log('--- RAW PAGE TEXT (around first %) ---');
            console.log(parsed.rawText);
            console.log('--- END RAW PAGE TEXT ---');
          }

          resolved = true;
          isScrapingUsage = false;
          clearTimeout(timeout);

          // Safely close window
          if (scraperWindow && !scraperWindow.isDestroyed()) {
            scraperWindow.close();
          }
          scraperWindow = null;

          // Convert bars array to our format
          const bars: UsageBar[] = parsed.bars.map((bar: { value: number; max: number; percentage: number; label?: string; context?: string; resetInfo?: string }) => ({
            used: bar.value,
            limit: bar.max,
            percentage: bar.percentage,
            label: bar.label,
            context: bar.resetInfo || bar.context  // Use resetInfo as context for display
          }));

          const standardBar = bars[0] || { used: 0, limit: 0, percentage: 0 };
          const advancedBar = bars[1] || { used: 0, limit: 0, percentage: 0 };

          resolve({
            standard: standardBar,
            advanced: advancedBar,
            bars: bars,  // Pass all bars for dynamic display
            resetDate: parsed.resetDate,
            lastUpdated: new Date().toISOString(),
            isAuthenticated: parsed.isAuthenticated,
            plan: parsed.plan || undefined,
            email: parsed.email || undefined,
          });
        }
      } catch (error) {
        // Ignore EPIPE errors that occur when window is destroyed during scraping
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!errorMessage.includes('EPIPE')) {
          console.error('Scraping error:', error);
        }
        if (!resolved) {
          resolved = true;
          isScrapingUsage = false;
          clearTimeout(timeout);
          if (scraperWindow && !scraperWindow.isDestroyed()) {
            scraperWindow.close();
          }
          scraperWindow = null;
          resolve(null);
        }
      }
    });

    scraperWindow.loadURL(CLAUDE_USAGE_URL);
  });
}

export function openLoginWindow(): Promise<boolean> {
  return new Promise((resolve) => {
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.focus();
      resolve(false);
      return;
    }

    loginWindow = new BrowserWindow({
      width: 500,
      height: 700,
      title: 'Login to Claude',
      webPreferences: {
        session: getSession(),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    loginWindow.on('closed', async () => {
      loginWindow = null;
      const auth = await isAuthenticated();
      resolve(auth);
    });

    // Watch for successful login by detecting navigation to dashboard
    loginWindow.webContents.on('did-navigate', async (_, url) => {
      if (url.includes('claude.ai') && !url.includes('login') && !url.includes('signup')) {
        // User successfully logged in
        setTimeout(() => {
          loginWindow?.close();
        }, 1000);
      }
    });

    loginWindow.loadURL('https://claude.ai/login');
  });
}

export async function scrapeBillingInfo(): Promise<BillingInfo | null> {
  // Prevent concurrent scrapes
  if (isScrapingBilling) {
    console.log('Billing scrape already in progress, skipping...');
    return null;
  }
  isScrapingBilling = true;
  console.log('Starting billing info scrape...');

  return new Promise((resolve) => {
    if (billingWindow && !billingWindow.isDestroyed()) {
      billingWindow.close();
    }

    billingWindow = new BrowserWindow({
      width: 1000,
      height: 800,
      show: false, // Set to true to debug
      webPreferences: {
        session: getSession(),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        console.log('Billing scraper timeout reached');
        resolved = true;
        isScrapingBilling = false;
        if (billingWindow && !billingWindow.isDestroyed()) {
          billingWindow.close();
        }
        billingWindow = null;
        resolve(null);
      }
    }, 30000);

    billingWindow.webContents.on('did-finish-load', async () => {
      if (resolved) return;
      if (!billingWindow || billingWindow.isDestroyed()) return;

      const currentUrl = billingWindow.webContents.getURL() || '';
      console.log('Billing page loaded:', currentUrl);

      // If redirected to login, user needs to authenticate
      if (currentUrl.includes('/login') || currentUrl.includes('/signup')) {
        console.log('Platform requires login');
        resolved = true;
        isScrapingBilling = false;
        clearTimeout(timeout);
        if (billingWindow && !billingWindow.isDestroyed()) {
          billingWindow.close();
        }
        billingWindow = null;
        resolve(null);
        return;
      }

      // Wait for JavaScript to render
      await new Promise(r => setTimeout(r, 3000));

      if (resolved || !billingWindow || billingWindow.isDestroyed()) return;

      try {
        const result = await billingWindow.webContents.executeJavaScript(`
          (function() {
            const billing = {
              creditBalance: null,
              currency: 'USD',
              needsLogin: false
            };

            const text = document.body.innerText;

            // Check if this is a login page
            if (text.includes('Sign in or create a developer account') ||
                text.includes('Continue with Google') && text.includes('Continue with email')) {
              billing.needsLogin = true;
              return JSON.stringify(billing);
            }

            // Look for credit balance patterns
            // Common formats: "$X.XX", "US$X.XX", "$X.XX remaining", "Credit balance: $X.XX"
            const balancePatterns = [
              /(?:Credit\\s*balance|Balance|Remaining)[:\\s]*\\$?([\\d,]+\\.\\d{2})/i,
              /\\$([\\d,]+\\.\\d{2})\\s*(?:remaining|credit|balance)/i,
              /US\\$([\\d,]+\\.\\d{2})/,
              /\\$([\\d,]+\\.\\d{2})/
            ];

            for (const pattern of balancePatterns) {
              const match = text.match(pattern);
              if (match) {
                billing.creditBalance = parseFloat(match[1].replace(/,/g, ''));
                break;
              }
            }

            return JSON.stringify(billing);
          })();
        `);

        if (resolved) return;

        if (result) {
          const parsed = JSON.parse(result);
          resolved = true;
          isScrapingBilling = false;
          clearTimeout(timeout);

          if (billingWindow && !billingWindow.isDestroyed()) {
            billingWindow.close();
          }
          billingWindow = null;

          // If needs login, return null
          if (parsed.needsLogin) {
            console.log('Platform billing requires login');
            resolve(null);
            return;
          }

          console.log('Billing scrape result:', parsed);

          resolve({
            creditBalance: parsed.creditBalance,
            currency: parsed.currency || 'USD',
            lastUpdated: new Date().toISOString(),
          });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!errorMessage.includes('EPIPE')) {
          console.error('Billing scraping error:', error);
        }
        if (!resolved) {
          resolved = true;
          isScrapingBilling = false;
          clearTimeout(timeout);
          if (billingWindow && !billingWindow.isDestroyed()) {
            billingWindow.close();
          }
          billingWindow = null;
          resolve(null);
        }
      }
    });

    billingWindow.loadURL(CLAUDE_BILLING_URL);
  });
}

export function openPlatformLoginWindow(): Promise<boolean> {
  return new Promise((resolve) => {
    if (platformLoginWindow && !platformLoginWindow.isDestroyed()) {
      platformLoginWindow.focus();
      resolve(false);
      return;
    }

    platformLoginWindow = new BrowserWindow({
      width: 600,
      height: 750,
      title: 'Login to Claude Platform',
      webPreferences: {
        session: getSession(),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    let hasLoggedIn = false;
    let wasOnLoginPage = false;

    platformLoginWindow.on('closed', () => {
      platformLoginWindow = null;
      resolve(hasLoggedIn);
    });

    // Only auto-close when user completes login (transitions from login page to billing page)
    platformLoginWindow.webContents.on('did-finish-load', async () => {
      if (!platformLoginWindow || platformLoginWindow.isDestroyed()) return;

      const url = platformLoginWindow.webContents.getURL();
      console.log('Platform login page:', url);

      // Check if we're on the billing page
      if (url.includes('platform.claude.com/settings/billing')) {
        // Wait for page to render
        await new Promise(r => setTimeout(r, 2000));

        if (!platformLoginWindow || platformLoginWindow.isDestroyed()) return;

        const isLoginPage = await platformLoginWindow.webContents.executeJavaScript(`
          document.body.innerText.includes('Sign in or create a developer account') ||
          document.body.innerText.includes('Continue with Google')
        `);

        if (isLoginPage) {
          // User needs to login - remember this
          wasOnLoginPage = true;
          console.log('Platform requires login, window stays open');
        } else {
          // User is logged in
          hasLoggedIn = true;

          // Only auto-close if user just completed login (was on login page before)
          // If already logged in from start, keep window open so user can close manually
          if (wasOnLoginPage) {
            console.log('Platform login completed, closing window...');
            setTimeout(() => {
              platformLoginWindow?.close();
            }, 1500);
          } else {
            console.log('Already logged in to platform, keeping window open');
            // Don't auto-close - let user close manually or it will close when they navigate away
          }
        }
      }
    });

    platformLoginWindow.loadURL('https://platform.claude.com/settings/billing');
  });
}
