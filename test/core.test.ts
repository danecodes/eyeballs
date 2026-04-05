import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Set EYEBALLS_HOME before importing core (module-level const reads it at import time)
const TEST_DIR = join(tmpdir(), `eyeballs-test-${randomUUID().slice(0, 8)}`);
process.env.EYEBALLS_HOME = TEST_DIR;

// Dynamic import so env var is set first
const { diff, loadWatches, listWatches, removeWatch, EyeballsError } = await import('../src/core.js');

const FIXTURES = join(import.meta.dirname, 'fixtures');
const red = () => readFileSync(join(FIXTURES, 'red-10x10.png'));
const blue = () => readFileSync(join(FIXTURES, 'blue-10x10.png'));
const redSmallDiff = () => readFileSync(join(FIXTURES, 'red-1pct-diff-10x10.png'));
const red20 = () => readFileSync(join(FIXTURES, 'red-20x20.png'));

function resetTestDir() {
  // Remove and recreate test directory
  const { rmSync } = require('fs');
  try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, 'screenshots'), { recursive: true });
}

// --- diff() tests ---

describe('diff', () => {
  it('returns no change for identical images', () => {
    const result = diff(red(), red());
    expect(result.changed).toBe(false);
    expect(result.diffPercent).toBe(0);
    expect(result.diffBuffer).toBeUndefined();
  });

  it('detects change between different images', () => {
    const result = diff(red(), blue());
    expect(result.changed).toBe(true);
    expect(result.diffPercent).toBe(100);
    expect(result.diffBuffer).toBeDefined();
  });

  it('detects small diff below default threshold', () => {
    const result = diff(red(), redSmallDiff());
    expect(result.changed).toBe(false);
    expect(result.diffPercent).toBeGreaterThan(0);
    expect(result.diffPercent).toBeLessThan(5);
  });

  it('respects custom threshold', () => {
    // 1% diff with 0.5% threshold should be "changed"
    const result = diff(red(), redSmallDiff(), 0.5);
    expect(result.changed).toBe(true);
    expect(result.diffBuffer).toBeDefined();
  });

  it('returns 100% diff for different dimensions', () => {
    const result = diff(red(), red20());
    expect(result.changed).toBe(true);
    expect(result.diffPercent).toBe(100);
    expect(result.diffBuffer).toBeUndefined();
  });

  it('supports region crop', () => {
    // Crop a 5x5 region from the 10x10 images
    const result = diff(red(), red(), 5, { x: 0, y: 0, width: 5, height: 5 });
    expect(result.changed).toBe(false);
    expect(result.diffPercent).toBe(0);
  });

  it('detects change in cropped region', () => {
    // The 1-pixel diff is at (5,5), crop a region that includes it
    const result = diff(red(), redSmallDiff(), 0, { x: 5, y: 5, width: 5, height: 5 });
    expect(result.changed).toBe(true);
    expect(result.diffPercent).toBeGreaterThan(0);
  });

  it('no change in cropped region that excludes the diff', () => {
    // The 1-pixel diff is at (5,5), crop a region that excludes it
    const result = diff(red(), redSmallDiff(), 5, { x: 0, y: 0, width: 5, height: 5 });
    expect(result.changed).toBe(false);
    expect(result.diffPercent).toBe(0);
  });

  it('produces a valid PNG diff buffer', () => {
    const result = diff(red(), blue());
    expect(result.diffBuffer).toBeDefined();
    // Should be parseable as PNG
    const { PNG } = require('pngjs');
    const parsed = PNG.sync.read(result.diffBuffer!);
    expect(parsed.width).toBe(10);
    expect(parsed.height).toBe(10);
  });
});

// --- Storage tests ---

describe('storage', () => {
  beforeEach(() => resetTestDir());

  it('loadWatches returns empty array when no watches.json', () => {
    const result = loadWatches();
    expect(result.watches).toEqual([]);
  });

  it('loadWatches reads existing watches.json', () => {
    const data = {
      watches: [{
        id: 'test-123',
        url: 'https://example.com',
        viewport: { width: 1280, height: 720 },
        mode: 'pixel',
        config: { threshold: 5, region: null },
        baselinePath: '/tmp/test.png',
        createdAt: '2026-04-05T00:00:00Z',
        lastCheckAt: null,
        lastDiffPercent: 0,
      }],
    };
    writeFileSync(join(TEST_DIR, 'watches.json'), JSON.stringify(data));
    const result = loadWatches();
    expect(result.watches).toHaveLength(1);
    expect(result.watches[0].url).toBe('https://example.com');
  });

  it('loadWatches handles corrupted watches.json', () => {
    writeFileSync(join(TEST_DIR, 'watches.json'), 'not json{{{');
    const result = loadWatches();
    expect(result.watches).toEqual([]);
  });

  it('listWatches returns empty array initially', () => {
    const result = listWatches();
    expect(result).toEqual([]);
  });
});

// --- removeWatch tests ---

describe('removeWatch', () => {
  beforeEach(() => resetTestDir());

  it('throws NOT_FOUND for unknown id', () => {
    // Write empty watches
    writeFileSync(join(TEST_DIR, 'watches.json'), JSON.stringify({ watches: [] }));
    expect(() => removeWatch('nonexistent')).toThrow(EyeballsError);
    try {
      removeWatch('nonexistent');
    } catch (e: unknown) {
      expect((e as InstanceType<typeof EyeballsError>).code).toBe('NOT_FOUND');
    }
  });

  it('removes watch and cleans up screenshots', () => {
    const watchId = 'abc12345';
    const data = {
      watches: [{
        id: watchId,
        url: 'https://example.com',
        viewport: { width: 1280, height: 720 },
        mode: 'pixel',
        config: { threshold: 5, region: null },
        baselinePath: join(TEST_DIR, 'screenshots', `${watchId}-baseline.png`),
        createdAt: '2026-04-05T00:00:00Z',
        lastCheckAt: null,
        lastDiffPercent: 0,
      }],
    };
    writeFileSync(join(TEST_DIR, 'watches.json'), JSON.stringify(data));
    // Create fake screenshot files
    writeFileSync(join(TEST_DIR, 'screenshots', `${watchId}-baseline.png`), red());
    writeFileSync(join(TEST_DIR, 'screenshots', `${watchId}-latest.png`), red());
    writeFileSync(join(TEST_DIR, 'screenshots', `${watchId}-diff.png`), red());

    removeWatch(watchId);

    // Watch should be gone
    const updated = loadWatches();
    expect(updated.watches).toHaveLength(0);

    // Screenshots should be cleaned up
    const files = readdirSync(join(TEST_DIR, 'screenshots'));
    const watchFiles = files.filter(f => f.startsWith(watchId));
    expect(watchFiles).toHaveLength(0);
  });

  it('removes watch even if screenshots already deleted', () => {
    const watchId = 'def67890';
    const data = {
      watches: [{
        id: watchId,
        url: 'https://example.com',
        viewport: { width: 1280, height: 720 },
        mode: 'pixel',
        config: { threshold: 5, region: null },
        baselinePath: join(TEST_DIR, 'screenshots', `${watchId}-baseline.png`),
        createdAt: '2026-04-05T00:00:00Z',
        lastCheckAt: null,
        lastDiffPercent: 0,
      }],
    };
    writeFileSync(join(TEST_DIR, 'watches.json'), JSON.stringify(data));
    // No screenshot files created

    removeWatch(watchId);

    const updated = loadWatches();
    expect(updated.watches).toHaveLength(0);
  });
});

// --- EyeballsError tests ---

describe('EyeballsError', () => {
  it('has correct code and message', () => {
    const err = new EyeballsError('TIMEOUT', 'Page failed to load');
    expect(err.code).toBe('TIMEOUT');
    expect(err.message).toBe('Page failed to load');
    expect(err.name).toBe('EyeballsError');
    expect(err).toBeInstanceOf(Error);
  });

  it('supports all error codes', () => {
    const codes = [
      'TIMEOUT', 'LOAD_FAILED', 'INVALID_URL',
      'BROWSER_NOT_INSTALLED', 'BROWSER_VERSION_MISMATCH',
      'BROWSER_LAUNCH_FAILED', 'STORAGE_FAILED', 'NOT_FOUND',
    ] as const;
    for (const code of codes) {
      const err = new EyeballsError(code, 'test');
      expect(err.code).toBe(code);
    }
  });
});
