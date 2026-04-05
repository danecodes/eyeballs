import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Set test storage dir
const TEST_DIR = join(tmpdir(), `eyeballs-mcp-test-${randomUUID().slice(0, 8)}`);
process.env.EYEBALLS_HOME = TEST_DIR;

// Mock playwright and autoconsent to avoid launching real browser
vi.mock('playwright', () => {
  const fixturePath = join(import.meta.dirname, 'fixtures', 'red-10x10.png');
  const { readFileSync: rfs } = require('fs');
  const screenshotBuffer = rfs(fixturePath);

  const mockPage = {
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    screenshot: vi.fn().mockResolvedValue(screenshotBuffer),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockReturnValue(Promise.resolve()),
  };
  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockReturnValue(Promise.resolve()),
  };
  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    isConnected: vi.fn().mockReturnValue(true),
    close: vi.fn().mockReturnValue(Promise.resolve()),
  };

  return {
    chromium: {
      launch: vi.fn().mockResolvedValue(mockBrowser),
    },
    _mockPage: mockPage,
  };
});

vi.mock('playwright-autoconsent', () => ({
  handleCookieConsent: vi.fn().mockResolvedValue(undefined),
}));

const { capture, checkUrl, listWatches, removeWatch } = await import('../src/core.js');
const { _mockPage } = await import('playwright') as any;

const FIXTURES = join(import.meta.dirname, 'fixtures');

function resetTestDir() {
  const { rmSync } = require('fs');
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, 'screenshots'), { recursive: true });
  writeFileSync(join(TEST_DIR, 'watches.json'), JSON.stringify({ watches: [] }));
}

describe('checkUrl', () => {
  beforeEach(() => resetTestDir());

  it('captures baseline on first call', async () => {
    const result = await checkUrl({ url: 'https://example.com' });
    expect(result.changed).toBe(false);
    expect(result.diffPercent).toBe(0);
    expect(result.message).toBe('Baseline captured');
    expect(result.watch.url).toBe('https://example.com');
  });

  it('returns no change on second call with same image', async () => {
    await checkUrl({ url: 'https://example.com' });
    const result = await checkUrl({ url: 'https://example.com' });
    expect(result.changed).toBe(false);
    expect(result.diffPercent).toBe(0);
    expect(result.message).toContain('No change');
  });

  it('detects change when image differs', async () => {
    await checkUrl({ url: 'https://example.com' });

    // Return different image on next call
    const blueBuffer = readFileSync(join(FIXTURES, 'blue-10x10.png'));
    _mockPage.screenshot.mockResolvedValueOnce(blueBuffer);

    const result = await checkUrl({ url: 'https://example.com' });
    expect(result.changed).toBe(true);
    expect(result.diffPercent).toBe(100);
    expect(result.diffBuffer).toBeDefined();
    expect(result.message).toContain('Changed');
  });

  it('resets baseline when resetBaseline is true', async () => {
    await checkUrl({ url: 'https://example.com' });
    const result = await checkUrl({ url: 'https://example.com', resetBaseline: true });
    expect(result.changed).toBe(false);
    expect(result.message).toBe('Baseline updated');
  });

  it('respects custom threshold', async () => {
    await checkUrl({ url: 'https://example.com' });

    const smallDiffBuffer = readFileSync(join(FIXTURES, 'red-1pct-diff-10x10.png'));
    _mockPage.screenshot.mockResolvedValueOnce(smallDiffBuffer);

    // Default threshold 5% should NOT flag 1% diff
    const result = await checkUrl({ url: 'https://example.com', threshold: 5 });
    expect(result.changed).toBe(false);
  });

  it('flags small diff with low threshold', async () => {
    await checkUrl({ url: 'https://example2.com' });

    const smallDiffBuffer = readFileSync(join(FIXTURES, 'red-1pct-diff-10x10.png'));
    _mockPage.screenshot.mockResolvedValueOnce(smallDiffBuffer);

    const result = await checkUrl({ url: 'https://example2.com', threshold: 0.5 });
    expect(result.changed).toBe(true);
  });

  it('stores watch in watches list', async () => {
    await checkUrl({ url: 'https://store-test.com' });
    const watches = listWatches();
    const found = watches.find(w => w.url === 'https://store-test.com');
    expect(found).toBeDefined();
    expect(found!.mode).toBe('pixel');
    expect(found!.config.threshold).toBe(5);
  });
});

describe('capture', () => {
  beforeEach(() => resetTestDir());

  it('returns buffer with dimensions and load time', async () => {
    const result = await capture('https://example.com');
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);
    expect(result.loadTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('accepts custom viewport', async () => {
    const result = await capture('https://example.com', { width: 1440, height: 900 });
    expect(result.width).toBe(1440);
    expect(result.height).toBe(900);
  });
});

describe('full pipeline', () => {
  beforeEach(() => resetTestDir());

  it('screenshot → check (baseline) → check (diff) → list → remove', async () => {
    // Screenshot
    const captureResult = await capture('https://pipeline.com');
    expect(captureResult.buffer).toBeDefined();

    // Check: baseline
    const baseline = await checkUrl({ url: 'https://pipeline.com' });
    expect(baseline.message).toBe('Baseline captured');
    const watchId = baseline.watch.id;

    // Check: same image = no change
    const check2 = await checkUrl({ url: 'https://pipeline.com' });
    expect(check2.changed).toBe(false);

    // List
    const watches = listWatches();
    expect(watches).toHaveLength(1);
    expect(watches[0].id).toBe(watchId);

    // Remove
    removeWatch(watchId);
    expect(listWatches()).toHaveLength(0);
  });
});
