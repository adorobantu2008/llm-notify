# LLM Notify Hub

**Unified notification system for all your AI assistants** - monitors Claude.ai, ChatGPT, Gemini, Grok, Claude Code, and Codex from a single dashboard.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     LLM NOTIFY HUB SERVER                    │
│                   http://localhost:3847                      │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │  WebSocket   │  │  REST API    │  │  Dashboard   │       │
│  │  Server      │  │  /api/event  │  │  Web UI      │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│                                                              │
│  ┌──────────────────────────────────────────────────┐       │
│  │  Notification Engine (sounds, alarms, desktop)   │       │
│  └──────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘
         ▲                  ▲
         │                  │
   ┌─────┴─────┐     ┌─────┴─────┐
   │  Chrome   │     │  VS Code  │
   │ Extension │     │ Extension │
   │           │     │           │
   │ Claude.ai │     │ Claude    │
   │ ChatGPT   │     │ Code      │
   │ Gemini    │     │ Codex     │
   │ Grok      │     │           │
   └───────────┘     └───────────┘
```

## Quick Start

### 1. Start the Hub Server

```bash
cd llm-notify-hub
npm install
npm start
```

The hub will start on `http://localhost:3847`. Open this URL in your browser to see the dashboard.

### 2. Install the Chrome Extension (for web-based LLMs)

1. Open Chrome and go to `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `chrome-extension` folder

The extension will now monitor:
- Claude.ai
- ChatGPT (chat.openai.com, chatgpt.com)
- Gemini (gemini.google.com)
- Grok (grok.com, x.com/i/grok)

### 3. Install the VS Code Extension (for Claude Code + Codex)

```bash
cd vscode-extension
npm install
npm run compile
```

Then in VS Code:
1. Press `Cmd+Shift+P` (or `Ctrl+Shift+P`)
2. Type "Developer: Install Extension from Location"
3. Select the `vscode-extension` folder

Or package it:
```bash
npm install -g vsce
vsce package
```
Then install the `.vsix` file.

### 4. Make sure the VS Code extension actually detects Claude Code/Codex

The extension triggers notifications based on **VS Code terminal activity**. For it to work:

1. **Run Claude Code/Codex inside VS Code’s terminal**, not an external terminal.
2. **Command-line must include a recognizable keyword**:
   - Claude Code: `claude`, `claude-code`, or `anthropic`
   - Codex: `codex`, `openai`, `chatgpt`, or `gpt`
3. **Confirm the extension is enabled**:
   - Settings → `LLM Notify: Enabled` = true
   - Settings → `LLM Notify: Detect Claude Code` = true
   - Settings → `LLM Notify: Detect Codex` = true
4. **Confirm the hub is reachable**:
   - Hub running on `http://localhost:3847`
   - Status bar shows `LLM Notify` (not crossed out)
5. **Claude Code terminal UI detection** (default):
   - Start of response: looks for `⏺`
   - Completion: looks for the prompt `❯` or `✻ Worked for`
   - You can customize these via settings:
     - `LLM Notify: Claude Prompt Pattern`
     - `LLM Notify: Claude Output Pattern`
     - `LLM Notify: Claude Complete Pattern`
6. **Fallback log file mode** (if terminal output events don’t fire):
   - Run Claude Code through a log-capturing shell:
     ```bash
     script -q /tmp/claude-code.log claude
     ```
   - Set `LLM Notify: Claude Log Path` to `/tmp/claude-code.log`
   - The extension will tail the file and trigger notifications automatically.
7. **Preferred: Claude Code SSE mode** (most reliable):
   - Get the port from your terminal (Claude Code sets this):
     ```bash
     echo $CLAUDE_CODE_SSE_PORT
     ```
   - Set `LLM Notify: Claude SSE Port` to that number
   - The extension will listen for start/complete events directly.

## Features

### Dashboard
- **Real-time status** of all monitored AI assistants
- **Completion history** with timestamps and durations
- **Per-source settings** - enable/disable notifications per AI
- **Sound presets** - 12 different notification sounds
- **Dark mode** support
- **Do Not Disturb** mode

### Notification Options
- **Desktop notifications** - Native OS notifications
- **Sound alerts** - Various presets from gentle chimes to attention-grabbing beeps
- **Persistent alarm** - Looping sound until dismissed

### Supported Sources

| Source | Monitor Type | How it Works |
|--------|--------------|--------------|
| Claude.ai | Chrome Extension | DOM observation for stop button |
| ChatGPT | Chrome Extension | DOM observation for streaming |
| Gemini | Chrome Extension | DOM observation for loading |
| Grok | Chrome Extension | DOM observation for streaming |
| Claude Code | VS Code Extension | Activity monitoring |
| Codex | VS Code Extension | Activity monitoring |

## API

The hub exposes a REST API for custom integrations:

### Report an Event
```bash
curl -X POST http://localhost:3847/api/event \
  -H "Content-Type: application/json" \
  -d '{"source": "claude-code", "status": "complete"}'
```

### Manual Triggers (when auto-detection doesn't work)
```bash
# Mark as "generating" (started)
curl -X POST http://localhost:3847/api/trigger/start \
  -H "Content-Type: application/json" \
  -d '{"source": "claude-code"}'

# Mark as "complete" (triggers notification)
curl -X POST http://localhost:3847/api/trigger/complete \
  -H "Content-Type: application/json" \
  -d '{"source": "claude-code"}'
```

You can create keyboard shortcuts (via Raycast, Alfred, Automator, etc.) to call these endpoints.

### Get Current State
```bash
curl http://localhost:3847/api/state
```

### Health Check
```bash
curl http://localhost:3847/api/health
```

## Configuration

### Hub Server
Edit settings directly in the dashboard or via API.

### VS Code Extension
Settings are available in VS Code under `LLM Notify`:
- `llmNotify.enabled` - Enable/disable the extension
- `llmNotify.hubUrl` - Hub server URL (default: http://localhost:3847)
- `llmNotify.showVSCodeNotification` - Show VS Code notifications

### Chrome Extension
Click the extension icon to access settings popup.

## Development

### Hub Server
```bash
npm run dev  # Runs with --watch for auto-reload
```

### VS Code Extension
```bash
cd vscode-extension
npm run watch  # Compile on file changes
```

### Chrome Extension
After making changes, go to `chrome://extensions` and click the reload button.

## Troubleshooting

### Hub not receiving events
1. Check that the hub is running (`npm start`)
2. Verify the URL is `http://localhost:3847`
3. Check browser console for errors

### Chrome extension not detecting completions
1. Refresh the AI website
2. Check the extension popup to ensure it's enabled
3. Check browser console for `[LLM Notify]` logs

### VS Code extension not working
1. Check the Output panel for "LLM Notify" logs
2. Verify the hub URL in settings
3. Check the status bar icon (bell icon)
4. Make sure you run Claude Code/Codex in the **VS Code integrated terminal**
5. Ensure your command includes one of the keywords listed above
6. If your terminal name is custom, include `claude` or `codex` in the terminal name to improve detection

## Project Structure

```
llm-notify-hub/
├── package.json              # Hub dependencies
├── server/
│   ├── index.js              # Main hub server
├── dashboard/
│   ├── index.html            # Dashboard UI
│   ├── styles.css            # Dashboard styles
│   ├── app.js                # Dashboard logic
│   └── audio.js              # Web Audio sound engine
├── chrome-extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   └── lib/
│       ├── detectors.js      # Site-specific detection
│       └── storage.js
└── vscode-extension/
    ├── package.json
    ├── tsconfig.json
    └── src/
        └── extension.ts
```

## License

MIT
