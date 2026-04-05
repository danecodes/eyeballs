# eyeballs

Visual monitoring for AI agents and humans. Take screenshots, detect visual changes, track what matters.

Ships as both a **CLI tool** and an **MCP server** in one package.

## Install

```bash
npm install -g eyeballs-cli
```

This installs Chromium automatically (~400MB on first install).

## CLI Usage

```bash
# Take a screenshot
eyeballs screenshot https://example.com
eyeballs screenshot https://example.com --viewport 1440x900 -o homepage.png

# Check for visual changes (captures baseline on first run)
eyeballs check https://example.com
eyeballs check https://example.com --threshold 10 --region 0,100,1280,500

# Re-check (diffs against baseline)
eyeballs check https://example.com

# Accept current state as new baseline
eyeballs check https://example.com --reset

# List watched URLs
eyeballs list

# Remove a watch
eyeballs remove <id>
```

## MCP Server

eyeballs works as an MCP server for AI agents (Claude Desktop, Claude Code, Cursor, etc.).

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "eyeballs": {
      "command": "eyeballs-mcp"
    }
  }
}
```

### Claude Code

```bash
claude mcp add eyeballs eyeballs-mcp
```

### Tools

| Tool | Description |
|------|-------------|
| `screenshot` | Take a screenshot of a URL. Returns the image directly. |
| `check_url` | Check a URL for visual changes against a stored baseline. |
| `list_watches` | List all monitored URLs and their status. |
| `remove_watch` | Remove a watch and its screenshots. |

### Example: screenshot

```
screenshot({ url: "https://example.com", viewport: { width: 1440, height: 900 } })
```

Returns the screenshot as an image the agent can see, plus metadata (dimensions, load time).

### Example: check_url

```
check_url({ url: "https://example.com", threshold: 5, region: { x: 0, y: 100, width: 1280, height: 500 } })
```

First call captures a baseline. Subsequent calls diff against it and report the percentage of pixels that changed. Use `reset_baseline: true` to accept the current state.

## Overlay Handling

eyeballs automatically dismisses cookie consent banners, chat widgets, and other overlays before taking screenshots. Three layers:

1. **CSS injection** hides common banners (OneTrust, Cookiebot, Intercom, Drift, Zendesk, etc.) before the page loads
2. **autoconsent** (via DuckDuckGo's database) clicks through 100+ known consent platforms
3. **Brute-force dismiss** finds and clicks remaining "Agree"/"Accept" buttons and removes overlay elements

No configuration needed. Works on most sites out of the box.

## How It Works

- **Screenshots** via Playwright (headless Chromium)
- **Diffing** via pixelmatch (deterministic pixel comparison, no AI needed)
- **Overlay removal** via CSS injection + autoconsent + button clicking
- **Storage** at `~/.eyeballs/` (baselines + screenshots as PNG files)
- **Threshold** default 5%, configurable per watch to reduce noise from dynamic content
- **Region crop** to monitor just the part of the page you care about

## Requirements

- Node.js 18+
- ~400MB disk for Chromium (installed automatically)

## License

MIT
