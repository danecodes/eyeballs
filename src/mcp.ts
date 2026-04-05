#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  capture,
  checkUrl,
  listWatches,
  removeWatch,
  EyeballsError,
  type Viewport,
  type Region,
} from './core.js';

const tools = [
  {
    name: 'screenshot',
    description:
      'Take a screenshot of a web page. Returns the image and metadata (width, height, load time).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'URL to screenshot (must start with http:// or https://)',
        },
        viewport: {
          type: 'object',
          description: 'Viewport size (default: 1280x720)',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'check_url',
    description:
      'Check a URL for visual changes. On first call, captures a baseline screenshot. On subsequent calls, compares against the baseline and reports the pixel diff percentage. Use reset_baseline to accept the current state as the new baseline.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'URL to check (must start with http:// or https://)',
        },
        viewport: {
          type: 'object',
          description: 'Viewport size (default: 1280x720). Stored with baseline for consistent diffs.',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        threshold: {
          type: 'number',
          description: 'Percentage of pixels that must differ to count as "changed" (default: 5)',
        },
        region: {
          type: 'object',
          description: 'Crop region to compare (exclude headers, ads, etc.)',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        reset_baseline: {
          type: 'boolean',
          description: 'Set to true to accept the current page as the new baseline',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_watches',
    description: 'List all stored baselines (watched URLs) and their last check status.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'remove_watch',
    description: 'Remove a stored baseline and its screenshots.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'The watch ID to remove (from list_watches)',
        },
      },
      required: ['id'],
    },
  },
];

async function handleTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Array<{ type: string; text?: string; data?: string; mimeType?: string }>> {
  switch (name) {
    case 'screenshot': {
      const result = await capture(
        args.url as string,
        args.viewport as Viewport | undefined,
      );
      const base64 = result.buffer.toString('base64');
      return [
        {
          type: 'image',
          data: base64,
          mimeType: 'image/png',
        },
        {
          type: 'text',
          text: JSON.stringify({
            width: result.width,
            height: result.height,
            loadTimeMs: result.loadTimeMs,
            base64Length: base64.length,
          }),
        },
      ];
    }

    case 'check_url': {
      const result = await checkUrl({
        url: args.url as string,
        viewport: args.viewport as Viewport | undefined,
        threshold: args.threshold as number | undefined,
        region: args.region as Region | undefined,
        resetBaseline: args.reset_baseline as boolean | undefined,
      });

      const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];

      // Return the current screenshot
      content.push({
        type: 'image',
        data: result.screenshotBuffer.toString('base64'),
        mimeType: 'image/png',
      });

      // If there's a diff image, return it too
      if (result.diffBuffer) {
        content.push({
          type: 'image',
          data: result.diffBuffer.toString('base64'),
          mimeType: 'image/png',
        });
      }

      // Text summary
      content.push({
        type: 'text',
        text: JSON.stringify({
          changed: result.changed,
          diffPercent: result.diffPercent,
          threshold: result.threshold,
          message: result.message,
          watchId: result.watch.id,
          url: result.watch.url,
        }),
      });

      return content;
    }

    case 'list_watches': {
      const watches = listWatches();
      if (watches.length === 0) {
        return [{ type: 'text', text: 'No watches. Use check_url to start monitoring a URL.' }];
      }
      return [
        {
          type: 'text',
          text: JSON.stringify(
            watches.map((w) => ({
              id: w.id,
              url: w.url,
              viewport: w.viewport,
              threshold: w.config.threshold,
              region: w.config.region,
              lastCheckAt: w.lastCheckAt,
              lastDiffPercent: w.lastDiffPercent,
              createdAt: w.createdAt,
            })),
            null,
            2,
          ),
        },
      ];
    }

    case 'remove_watch': {
      removeWatch(args.id as string);
      return [{ type: 'text', text: `Watch ${args.id} removed.` }];
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: 'eyeballs', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const content = await handleTool(name, (args ?? {}) as Record<string, unknown>);
    return { content };
  } catch (error) {
    const message =
      error instanceof EyeballsError
        ? `${error.code}: ${error.message}`
        : `Error: ${(error as Error).message}`;
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('eyeballs MCP server running');
