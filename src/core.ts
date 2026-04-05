import { chromium, type Browser, type Page } from 'playwright';
import { handleCookieConsent } from 'playwright-autoconsent';
import pixelmatch from 'pixelmatch';
import { PNG, type PNGWithMetadata } from 'pngjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

// CSS to hide common cookie/consent banners before JS loads
const CONSENT_HIDE_CSS = `
  #onetrust-consent-sdk, #onetrust-banner-sdk,
  #CookieConsentContainer, #cookie-banner, #cookie-consent, #cookie-notice,
  .cc-window, .cc-banner, .cc-overlay,
  .cookie-banner, .cookie-consent, .cookie-notice,
  .qc-cmp2-container, .qc-cmp-showing,
  #truste-consent-track, #trustarc-banner-overlay,
  .osano-cm-window, .evidon-consent-button,
  [class*="cookieConsent"], [class*="cookie-consent"], [class*="cookie-banner"],
  [id*="cookie-banner"], [id*="cookieconsent"],
  [aria-label*="cookie" i], [aria-label*="consent" i],
  .gdpr-banner, .privacy-banner,
  .onetrust-pc-dark-filter, [class*="cookie-overlay"], [class*="consent-overlay"],
  /* Chat widgets */
  #intercom-container, #intercom-frame, .intercom-lightweight-app,
  #hubspot-messages-iframe-container, #hs-eu-cookie-confirmation,
  #drift-widget, #drift-frame-controller, #drift-frame-chat,
  .crisp-client, #crisp-chatbox,
  #tidio-chat, #tidio-chat-iframe,
  .fb_dialog, .fb-customerchat,
  #launcher, iframe[title="chat widget"],
  [class*="zendesk"], #webWidget, #Smallchat,
  .tawk-min-container, #tawk-tooltip-container,
  [id*="livechat"], [class*="livechat"],
  [id*="chat-widget"], [class*="chat-widget"] {
    display: none !important;
    visibility: hidden !important;
  }
`;

// --- Types ---

export interface Viewport {
  width: number;
  height: number;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureResult {
  buffer: Buffer;
  width: number;
  height: number;
  loadTimeMs: number;
}

export interface DiffResult {
  changed: boolean;
  diffPercent: number;
  threshold: number;
  diffBuffer?: Buffer;
}

export interface Watch {
  id: string;
  url: string;
  viewport: Viewport;
  mode: 'pixel';
  config: {
    threshold: number;
    region: Region | null;
  };
  baselinePath: string;
  createdAt: string;
  lastCheckAt: string | null;
  lastDiffPercent: number;
}

export interface WatchesFile {
  watches: Watch[];
}

export interface CheckResult {
  changed: boolean;
  diffPercent: number;
  threshold: number;
  message: string;
  screenshotBuffer: Buffer;
  diffBuffer?: Buffer;
  watch: Watch;
}

// --- Error types ---

export type EyeballsErrorCode =
  | 'TIMEOUT'
  | 'LOAD_FAILED'
  | 'INVALID_URL'
  | 'BROWSER_NOT_INSTALLED'
  | 'BROWSER_VERSION_MISMATCH'
  | 'BROWSER_LAUNCH_FAILED'
  | 'STORAGE_FAILED'
  | 'NOT_FOUND';

export class EyeballsError extends Error {
  constructor(
    public code: EyeballsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EyeballsError';
  }
}

// --- Storage ---

const EYEBALLS_DIR = join(homedir(), '.eyeballs');
const SCREENSHOTS_DIR = join(EYEBALLS_DIR, 'screenshots');
const WATCHES_FILE = join(EYEBALLS_DIR, 'watches.json');

function ensureDirs(): void {
  try {
    mkdirSync(EYEBALLS_DIR, { recursive: true });
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  } catch {
    throw new EyeballsError('STORAGE_FAILED', 'Could not create ~/.eyeballs directory');
  }
}

export function loadWatches(): WatchesFile {
  ensureDirs();
  if (!existsSync(WATCHES_FILE)) {
    return { watches: [] };
  }
  try {
    const raw = readFileSync(WATCHES_FILE, 'utf-8');
    return JSON.parse(raw) as WatchesFile;
  } catch {
    return { watches: [] };
  }
}

function saveWatches(data: WatchesFile): void {
  ensureDirs();
  try {
    writeFileSync(WATCHES_FILE, JSON.stringify(data, null, 2));
  } catch {
    throw new EyeballsError('STORAGE_FAILED', 'Could not write watches.json');
  }
}

function saveScreenshot(id: string, suffix: string, buffer: Buffer): string {
  ensureDirs();
  const filename = `${id}-${suffix}.png`;
  const filepath = join(SCREENSHOTS_DIR, filename);
  try {
    writeFileSync(filepath, buffer);
  } catch {
    throw new EyeballsError('STORAGE_FAILED', 'Could not write screenshot');
  }
  return filepath;
}

// --- Browser ---

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) {
    return browser;
  }
  try {
    browser = await chromium.launch();
    return browser;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Executable doesn\'t exist') || msg.includes('browserType.launch')) {
      if (msg.includes('Chromium') && msg.includes('revision')) {
        throw new EyeballsError(
          'BROWSER_VERSION_MISMATCH',
          'Chromium version mismatch. Run: npx playwright install chromium',
        );
      }
      throw new EyeballsError(
        'BROWSER_NOT_INSTALLED',
        'Run: npx playwright install chromium',
      );
    }
    throw new EyeballsError('BROWSER_LAUNCH_FAILED', `Chromium cannot start: ${msg}`);
  }
}

export async function shutdownBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

// Cleanup on exit
process.on('exit', () => {
  browser?.close().catch(() => {});
});
process.on('SIGINT', async () => {
  await shutdownBrowser();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await shutdownBrowser();
  process.exit(0);
});

// --- URL validation ---

function validateUrl(url: string): void {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new EyeballsError('INVALID_URL', 'URL must start with http:// or https://');
  }
  try {
    new URL(url);
  } catch {
    throw new EyeballsError('INVALID_URL', `Invalid URL: ${url}`);
  }
}

// --- Capture ---

export async function capture(
  url: string,
  viewport: Viewport = { width: 1280, height: 720 },
): Promise<CaptureResult> {
  validateUrl(url);

  const b = await getBrowser();
  const context = await b.newContext({ viewport });

  // Layer 1: CSS injection to hide consent banners before JS loads
  await context.addInitScript((css: string) => {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }, CONSENT_HIDE_CSS);

  const page: Page = await context.newPage();

  const start = Date.now();
  try {
    const response = await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    if (response) {
      const status = response.status();
      if (status >= 400) {
        throw new EyeballsError('LOAD_FAILED', `Page returned ${status}`);
      }
    }

    // Layer 2: autoconsent clicks through any remaining cookie dialogs
    try {
      await handleCookieConsent(page);
    } catch {
      // Not all pages have consent popups
    }

    // Layer 3: brute-force dismiss any remaining modals/overlays
    await page.evaluate(() => {
      // Click common "agree/accept/dismiss" buttons
      const buttonTexts = ['agree', 'accept', 'ok', 'i agree', 'got it', 'continue', 'dismiss', 'close'];
      const buttons = document.querySelectorAll('button, a[role="button"], [class*="btn"], [class*="button"]');
      for (const btn of buttons) {
        const text = (btn as HTMLElement).textContent?.trim().toLowerCase() || '';
        if (buttonTexts.includes(text)) {
          (btn as HTMLElement).click();
          break;
        }
      }
      // Remove any remaining overlays/backdrops
      const overlays = document.querySelectorAll('[class*="overlay"], [class*="backdrop"], [class*="modal-bg"]');
      for (const el of overlays) {
        const style = window.getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'absolute') {
          (el as HTMLElement).style.display = 'none';
        }
      }
      // Restore scroll
      document.body.style.overflow = 'auto';
      document.documentElement.style.overflow = 'auto';
    });

    // Wait for paint to settle
    await page.waitForTimeout(2000);

    const buffer = await page.screenshot({ type: 'png' });
    const loadTimeMs = Date.now() - start;

    return {
      buffer: Buffer.from(buffer),
      width: viewport.width,
      height: viewport.height,
      loadTimeMs,
    };
  } catch (err) {
    if (err instanceof EyeballsError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Timeout') || msg.includes('timeout')) {
      throw new EyeballsError('TIMEOUT', 'Page failed to load within 30s');
    }
    throw new EyeballsError('LOAD_FAILED', `Failed to load page: ${msg}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// --- Diff ---

export function diff(
  baseline: Buffer,
  current: Buffer,
  threshold: number = 5,
  region?: Region | null,
): DiffResult {
  let img1: PNGWithMetadata | PNG = PNG.sync.read(baseline);
  let img2: PNGWithMetadata | PNG = PNG.sync.read(current);

  // Region crop if specified
  if (region) {
    img1 = cropPng(img1, region);
    img2 = cropPng(img2, region);
  }

  // Ensure same dimensions
  if (img1.width !== img2.width || img1.height !== img2.height) {
    return {
      changed: true,
      diffPercent: 100,
      threshold,
      diffBuffer: undefined,
    };
  }

  const { width, height } = img1;
  const diffPng = new PNG({ width, height });

  const numDiffPixels = pixelmatch(
    img1.data as unknown as Uint8Array,
    img2.data as unknown as Uint8Array,
    diffPng.data as unknown as Uint8Array,
    width,
    height,
    { threshold: 0.1 },
  );

  const totalPixels = width * height;
  const diffPercent = (numDiffPixels / totalPixels) * 100;
  const changed = diffPercent > threshold;

  return {
    changed,
    diffPercent: Math.round(diffPercent * 100) / 100,
    threshold,
    diffBuffer: changed ? Buffer.from(PNG.sync.write(diffPng)) : undefined,
  };
}

function cropPng(png: PNG, region: Region): PNG {
  const cropped = new PNG({ width: region.width, height: region.height });
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const srcIdx = ((region.y + y) * png.width + (region.x + x)) << 2;
      const dstIdx = (y * region.width + x) << 2;
      cropped.data[dstIdx] = png.data[srcIdx];
      cropped.data[dstIdx + 1] = png.data[srcIdx + 1];
      cropped.data[dstIdx + 2] = png.data[srcIdx + 2];
      cropped.data[dstIdx + 3] = png.data[srcIdx + 3];
    }
  }
  return cropped;
}

// --- Check URL (baseline + diff) ---

export async function checkUrl(options: {
  url: string;
  viewport?: Viewport;
  threshold?: number;
  region?: Region | null;
  resetBaseline?: boolean;
}): Promise<CheckResult> {
  const { url, viewport = { width: 1280, height: 720 }, threshold = 5, region = null, resetBaseline = false } = options;

  const data = loadWatches();
  let watch = data.watches.find((w) => w.url === url);

  // Capture current screenshot
  const result = await capture(url, viewport);

  // Reset baseline
  if (watch && resetBaseline) {
    const baselinePath = saveScreenshot(watch.id, 'baseline', result.buffer);
    watch.baselinePath = baselinePath;
    watch.viewport = viewport;
    watch.config = { threshold, region };
    watch.lastCheckAt = new Date().toISOString();
    watch.lastDiffPercent = 0;
    saveWatches(data);

    return {
      changed: false,
      diffPercent: 0,
      threshold,
      message: 'Baseline updated',
      screenshotBuffer: result.buffer,
      watch,
    };
  }

  // No baseline yet, store it
  if (!watch) {
    const id = randomUUID().slice(0, 8);
    const baselinePath = saveScreenshot(id, 'baseline', result.buffer);

    watch = {
      id,
      url,
      viewport,
      mode: 'pixel',
      config: { threshold, region },
      baselinePath,
      createdAt: new Date().toISOString(),
      lastCheckAt: new Date().toISOString(),
      lastDiffPercent: 0,
    };

    data.watches.push(watch);
    saveWatches(data);

    return {
      changed: false,
      diffPercent: 0,
      threshold,
      message: 'Baseline captured',
      screenshotBuffer: result.buffer,
      watch,
    };
  }

  // Diff against baseline
  const baseline = readFileSync(watch.baselinePath);
  const diffResult = diff(baseline, result.buffer, threshold, region);

  // Save current screenshot
  saveScreenshot(watch.id, 'latest', result.buffer);
  if (diffResult.diffBuffer) {
    saveScreenshot(watch.id, 'diff', diffResult.diffBuffer);
  }

  watch.lastCheckAt = new Date().toISOString();
  watch.lastDiffPercent = diffResult.diffPercent;
  saveWatches(data);

  return {
    changed: diffResult.changed,
    diffPercent: diffResult.diffPercent,
    threshold,
    message: diffResult.changed
      ? `Changed: ${diffResult.diffPercent}% pixels differ (threshold: ${threshold}%)`
      : `No change: ${diffResult.diffPercent}% pixels differ (threshold: ${threshold}%)`,
    screenshotBuffer: result.buffer,
    diffBuffer: diffResult.diffBuffer,
    watch,
  };
}

// --- List / Remove watches ---

export function listWatches(): Watch[] {
  return loadWatches().watches;
}

export function removeWatch(id: string): void {
  const data = loadWatches();
  const idx = data.watches.findIndex((w) => w.id === id);

  if (idx === -1) {
    throw new EyeballsError('NOT_FOUND', `Watch ${id} not found`);
  }

  data.watches.splice(idx, 1);
  saveWatches(data);

  // Clean up screenshot files for this watch
  try {
    const files = readdirSync(SCREENSHOTS_DIR);
    for (const file of files) {
      if (file.startsWith(`${id}-`)) {
        unlinkSync(join(SCREENSHOTS_DIR, file));
      }
    }
  } catch {
    // Best effort cleanup
  }
}
