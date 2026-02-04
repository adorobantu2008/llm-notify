# LLM Notify — Claude Code + Codex Monitor

LLM Notify keeps you in flow by alerting you the moment **Codex** or **Claude Code** finishes generating. It pairs with the **LLM Notify Hub** desktop app (required) and triggers sound/alarms plus optional VS Code popups.

## Why it’s useful

- **Instant completion alerts** while you multitask
- **Works with Codex + Claude Code** inside VS Code terminals
- **Local‑only**: no data sent to third‑party servers
- **Quiet by default** with optional alarm mode

## Requirements

- LLM Notify Hub app running locally (`http://localhost:3847`)
- VS Code 1.85+

> The extension will not notify unless the hub is running.

## Features

- Completion detection for **Codex** and **Claude Code**
- Optional VS Code notifications
- Hub‑driven sounds and alarms
- Status bar indicator (connected / disconnected)

## Quick start

1) Install **LLM Notify Hub** and start the app.
2) Install this extension.
3) Use the command **“LLM Notify: Test Notification”** to verify.

## Commands

- **LLM Notify: Test Notification**
- **LLM Notify: Open Dashboard**
- **LLM Notify: Toggle Notifications**
- **LLM Notify: Dismiss Alarm**

## Settings

- `llmNotify.enabled` — enable/disable the extension
- `llmNotify.hubUrl` — hub URL (default `http://localhost:3847`)
- `llmNotify.showVSCodeNotification` — VS Code popup on completion
- `llmNotify.detectClaudeCode` — detect Claude Code in terminal
- `llmNotify.detectCodex` — detect Codex in terminal

## Troubleshooting

**No sound?**
- Make sure the hub app is running.
- Open the hub dashboard once and click anywhere to unlock audio.

**No notifications at all?**
- Check the status bar: bell icon = connected, bell‑slash = not connected.
- Run **LLM Notify: Test Notification**.

## Privacy

All processing is local. No prompts or outputs leave your machine.
