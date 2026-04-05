#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { exec } from 'child_process';
import { platform } from 'os';
import {
  capture,
  checkUrl,
  listWatches,
  removeWatch,
  shutdownBrowser,
  EyeballsError,
} from './core.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

const program = new Command();

program
  .name('eyeballs')
  .description('Visual monitoring for AI agents and humans')
  .version('0.1.0');

// --- screenshot ---

program
  .command('screenshot')
  .description('Take a screenshot of a URL')
  .argument('<url>', 'URL to screenshot')
  .option('--viewport <size>', 'Viewport size (e.g., 1280x720)', '1280x720')
  .option('-o, --output <path>', 'Output file path')
  .option('--no-open', 'Do not open the screenshot after saving')
  .action(async (url: string, opts: { viewport: string; output?: string; open: boolean }) => {
    const spinner = ora('Capturing screenshot...').start();
    try {
      const [w, h] = opts.viewport.split('x').map(Number);
      const viewport = { width: w || 1280, height: h || 720 };

      const result = await capture(url, viewport);

      const output = opts.output || `screenshot-${Date.now()}.png`;
      writeFileSync(output, result.buffer);
      spinner.succeed(`Screenshot saved: ${chalk.cyan(output)} (${result.width}x${result.height}, ${result.loadTimeMs}ms)`);

      if (opts.open) {
        openFile(output);
      }
    } catch (err) {
      handleError(spinner, err);
    } finally {
      await shutdownBrowser();
    }
  });

// --- check ---

program
  .command('check')
  .description('Check a URL for visual changes')
  .argument('<url>', 'URL to check')
  .option('--viewport <size>', 'Viewport size (e.g., 1280x720)', '1280x720')
  .option('--threshold <percent>', 'Diff threshold percentage', '5')
  .option('--region <coords>', 'Crop region: x,y,width,height')
  .option('--reset', 'Reset baseline to current state')
  .action(async (url: string, opts: { viewport: string; threshold: string; region?: string; reset?: boolean }) => {
    const spinner = ora('Checking URL...').start();
    try {
      const [w, h] = opts.viewport.split('x').map(Number);
      const viewport = { width: w || 1280, height: h || 720 };
      const threshold = parseFloat(opts.threshold);

      let region = undefined;
      if (opts.region) {
        const [x, y, rw, rh] = opts.region.split(',').map(Number);
        region = { x, y, width: rw, height: rh };
      }

      const result = await checkUrl({
        url,
        viewport,
        threshold,
        region,
        resetBaseline: opts.reset,
      });

      if (result.message === 'Baseline captured') {
        spinner.succeed(`Baseline captured for ${chalk.cyan(url)} (watch ID: ${chalk.yellow(result.watch.id)})`);
      } else if (result.message === 'Baseline updated') {
        spinner.succeed(`Baseline updated for ${chalk.cyan(url)}`);
      } else if (result.changed) {
        spinner.warn(
          `${chalk.red('CHANGED')}: ${chalk.cyan(url)} — ${chalk.yellow(result.diffPercent + '%')} pixels differ (threshold: ${result.threshold}%)`,
        );
      } else {
        spinner.succeed(
          `${chalk.green('No change')}: ${chalk.cyan(url)} — ${chalk.dim(result.diffPercent + '%')} pixels differ`,
        );
      }
    } catch (err) {
      handleError(spinner, err);
    } finally {
      await shutdownBrowser();
    }
  });

// --- list ---

program
  .command('list')
  .description('List watched URLs')
  .action(() => {
    const watches = listWatches();

    if (watches.length === 0) {
      console.log(chalk.dim('No watches. Run `eyeballs check <url>` to start monitoring.'));
      return;
    }

    console.log(chalk.bold(`\n${watches.length} watch${watches.length === 1 ? '' : 'es'}:\n`));
    for (const w of watches) {
      const diffColor = w.lastDiffPercent > (w.config.threshold || 5) ? chalk.red : chalk.green;
      console.log(
        `  ${chalk.yellow(w.id)}  ${chalk.cyan(w.url)}`,
      );
      console.log(
        `    ${chalk.dim('viewport:')} ${w.viewport.width}x${w.viewport.height}  ${chalk.dim('threshold:')} ${w.config.threshold}%  ${chalk.dim('last diff:')} ${diffColor(w.lastDiffPercent + '%')}`,
      );
      if (w.lastCheckAt) {
        console.log(`    ${chalk.dim('last check:')} ${w.lastCheckAt}`);
      }
      console.log();
    }
  });

// --- remove ---

program
  .command('remove')
  .description('Remove a watch and its screenshots')
  .argument('<id>', 'Watch ID to remove')
  .action((id: string) => {
    try {
      removeWatch(id);
      console.log(chalk.green(`Watch ${id} removed.`));
    } catch (err) {
      if (err instanceof EyeballsError) {
        console.error(chalk.red(`${err.code}: ${err.message}`));
        process.exit(1);
      }
      throw err;
    }
  });

// --- helpers ---

function handleError(spinner: ReturnType<typeof ora>, err: unknown): void {
  if (err instanceof EyeballsError) {
    spinner.fail(chalk.red(`${err.code}: ${err.message}`));
  } else {
    spinner.fail(chalk.red((err as Error).message));
  }
  process.exit(1);
}

function openFile(path: string): void {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(join(process.cwd(), path))}`);
}

program.parse();
