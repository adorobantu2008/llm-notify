const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const notifier = require('node-notifier');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const PORT = 3847;
const HOST = '127.0.0.1';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Event bus for internal communication
const eventBus = new EventEmitter();

const SETTINGS_PATH = path.join(__dirname, 'settings.json');

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return null;
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[SETTINGS] Failed to load settings:', err.message);
    return null;
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(state.settings, null, 2));
  } catch (err) {
    console.warn('[SETTINGS] Failed to save settings:', err.message);
  }
}

// In-memory state
const state = {
  sessions: {},
  completions: [],
  settings: {
    enabled: true,
    doNotDisturb: false,
    dndSchedule: {
      enabled: false,
      start: '22:00',
      end: '07:00'
    },
    notifications: {
      desktop: true,
      sound: true,
      soundPreset: 'chime',
      alarm: false,
      alarmVolume: 0.3
    },
    sources: {}
  },
  alarm: {
    isActive: false,
    source: null,
    startTime: null
  },
  clients: {
    dashboards: 0,
    audioReady: 0
  }
};

const persistedSettings = loadSettings();
if (persistedSettings) {
  state.settings = {
    ...state.settings,
    ...persistedSettings,
    dndSchedule: { ...state.settings.dndSchedule, ...(persistedSettings.dndSchedule || {}) },
    notifications: { ...state.settings.notifications, ...(persistedSettings.notifications || {}) },
    sources: { ...state.settings.sources, ...(persistedSettings.sources || {}) }
  };
}

// Keep max 50 completions in history
const MAX_COMPLETIONS = 50;
const STALE_SESSION_MS = 15 * 60 * 1000;
const STALE_READY_MS = 3 * 60 * 1000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dashboard')));

// CORS for Chrome extension
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============ REST API ============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Get current state
app.get('/api/state', (req, res) => {
  res.json(state);
});

// Get settings
app.get('/api/settings', (req, res) => {
  res.json(state.settings);
});

// Update settings
app.post('/api/settings', (req, res) => {
  const updates = req.body;
  state.settings = {
    ...state.settings,
    ...updates,
    dndSchedule: { ...state.settings.dndSchedule, ...(updates.dndSchedule || {}) },
    notifications: { ...state.settings.notifications, ...(updates.notifications || {}) },
    sources: { ...state.settings.sources, ...(updates.sources || {}) }
  };
  broadcastToClients({ type: 'SETTINGS_UPDATED', settings: state.settings });
  saveSettings();
  res.json({ success: true, settings: state.settings });
});

// Receive event from any source
app.post('/api/event', (req, res) => {
  const { source, status, message, duration, displayName, origin, domains } = req.body;

  if (!source || !status) {
    return res.status(400).json({ error: 'Missing source or status' });
  }

  console.log(`[EVENT] ${source}: ${status}${message ? ` - ${message}` : ''}`);

  // Normalize source name
  const normalizedSource = normalizeSource(source);

  // Update session state (create if missing)
  if (!state.sessions[normalizedSource]) {
    state.sessions[normalizedSource] = {
      status: 'idle',
      lastActivity: null,
      source: 'Chrome Extension',
      displayName: displayName || normalizedSource
    };
    state.settings.sources[normalizedSource] = { enabled: true };
    saveSettings();
  }
  if (state.settings.sources[normalizedSource]?.hidden) {
    state.settings.sources[normalizedSource].hidden = false;
    saveSettings();
  }
  state.sessions[normalizedSource].status = status;
  state.sessions[normalizedSource].lastActivity = new Date().toISOString();
  if (displayName) {
    state.sessions[normalizedSource].displayName = displayName;
    state.settings.sources[normalizedSource] = {
      ...(state.settings.sources[normalizedSource] || {}),
      displayName
    };
    saveSettings();
  }

  if (origin || (Array.isArray(domains) && domains.length)) {
    state.settings.sources[normalizedSource] = {
      ...(state.settings.sources[normalizedSource] || {}),
      origin: origin || state.settings.sources[normalizedSource]?.origin,
      domains: Array.isArray(domains) ? domains : state.settings.sources[normalizedSource]?.domains
    };
    saveSettings();
  }

  // Handle completion events
  if (status === 'complete') {
    handleCompletion(normalizedSource, duration, origin);
  } else if (status === 'generating') {
    // Mark as generating, no notification needed
  }

  // Broadcast to all connected dashboard clients
  broadcastToClients({
    type: 'SESSION_UPDATE',
    source: normalizedSource,
    status,
    timestamp: new Date().toISOString()
  });

  res.json({ success: true });
});

// Dismiss alarm
app.post('/api/dismiss', (req, res) => {
  dismissAlarm();
  res.json({ success: true });
});

// Launch at Login - macOS only
const LAUNCH_AGENT_LABEL = 'com.llmnotifyhub.app';
const LAUNCH_AGENT_PATH = path.join(os.homedir(), 'Library/LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);

function getAppExecutablePath() {
  if (process.platform !== 'darwin') return null;

  if (process.execPath.includes('.app/Contents/MacOS/')) {
    return process.execPath;
  }

  const appPaths = [
    '/Applications/LLM Notify Hub.app',
    `${process.env.HOME}/Applications/LLM Notify Hub.app`,
    `${process.env.HOME}/Downloads/LLM Notify Hub.app`,
    path.resolve(__dirname, '../../downloads/LLM Notify Hub.app'),
    path.resolve(__dirname, '../.build/macos/LLM Notify Hub.app')
  ];

  for (const p of appPaths) {
    if (fs.existsSync(p)) {
      return path.join(p, 'Contents', 'MacOS', 'llm-notify-hub');
    }
  }

  return null;
}

function buildLaunchAgentPlist(executablePath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${executablePath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>`;
}

app.get('/api/launch-at-login', (req, res) => {
  if (process.platform !== 'darwin') {
    return res.json({ supported: false, enabled: false });
  }

  const enabled = fs.existsSync(LAUNCH_AGENT_PATH);
  res.json({ supported: true, enabled });
});

app.post('/api/launch-at-login', (req, res) => {
  if (process.platform !== 'darwin') {
    return res.json({ success: false, error: 'Only supported on macOS' });
  }

  const { enabled } = req.body;
  const { exec } = require('child_process');

  const executablePath = getAppExecutablePath();
  if (!executablePath) {
    return res.json({ success: false, error: 'Could not find app executable' });
  }

  try {
    fs.mkdirSync(path.dirname(LAUNCH_AGENT_PATH), { recursive: true });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const launchTarget = uid !== null ? `gui/${uid}` : 'gui/0';

  if (enabled) {
    try {
      fs.writeFileSync(LAUNCH_AGENT_PATH, buildLaunchAgentPlist(executablePath));
    } catch (e) {
      return res.json({ success: false, error: e.message });
    }
    exec(`launchctl bootout ${launchTarget} "${LAUNCH_AGENT_PATH}"`, () => {
      exec(`launchctl bootstrap ${launchTarget} "${LAUNCH_AGENT_PATH}"`, (err) => {
        if (err) {
          return res.json({ success: false, error: err.message });
        }
        exec(`launchctl enable ${launchTarget}/${LAUNCH_AGENT_LABEL}`, () => {
          res.json({ success: true, enabled: true });
        });
      });
    });
  } else {
    exec(`launchctl bootout ${launchTarget} "${LAUNCH_AGENT_PATH}"`, (err) => {
      if (err) {
        return res.json({ success: false, error: err.message });
      }
      try {
        if (fs.existsSync(LAUNCH_AGENT_PATH)) {
          fs.unlinkSync(LAUNCH_AGENT_PATH);
        }
      } catch (e) {
        return res.json({ success: false, error: e.message });
      }
      res.json({ success: true, enabled: false });
    });
  }
});

// Manual trigger endpoints (for when automatic detection doesn't work)
app.post('/api/trigger/start', (req, res) => {
  const { source } = req.body;
  if (!source) {
    return res.status(400).json({ error: 'Missing source' });
  }
  const normalizedSource = normalizeSource(source);

  console.log(`[MANUAL] Started: ${normalizedSource}`);

  if (state.sessions[normalizedSource]) {
    state.sessions[normalizedSource].status = 'generating';
    state.sessions[normalizedSource].lastActivity = new Date().toISOString();
  }

  broadcastToClients({
    type: 'SESSION_UPDATE',
    source: normalizedSource,
    status: 'generating',
    timestamp: new Date().toISOString()
  });

  res.json({ success: true, source: normalizedSource });
});

app.post('/api/trigger/complete', (req, res) => {
  const { source } = req.body;
  if (!source) {
    return res.status(400).json({ error: 'Missing source' });
  }
  const normalizedSource = normalizeSource(source);

  console.log(`[MANUAL] Complete: ${normalizedSource}`);

  if (state.sessions[normalizedSource]) {
    state.sessions[normalizedSource].status = 'complete';
    state.sessions[normalizedSource].lastActivity = new Date().toISOString();
  }

  broadcastToClients({
    type: 'SESSION_UPDATE',
    source: normalizedSource,
    status: 'complete',
    timestamp: new Date().toISOString()
  });

  handleCompletion(normalizedSource, null);
  res.json({ success: true, source: normalizedSource });
});

// Get completions history
app.get('/api/completions', (req, res) => {
  res.json(state.completions);
});

// ============ WebSocket ============

const clients = new Set();
const pendingAudioAcks = new Map();

function updateAudioReadyCount() {
  let ready = 0;
  clients.forEach((client) => {
    if (client.isAudioReady) ready += 1;
  });
  state.clients.audioReady = ready;
}

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('[WS] Client connected. Total:', clients.size);
  state.clients.dashboards = clients.size;
  ws.isAudioReady = false;
  updateAudioReadyCount();

  // Send current state on connect
  ws.send(JSON.stringify({
    type: 'INIT',
    state: state
  }));
  broadcastToClients({ type: 'CLIENTS_UPDATE', clients: state.clients });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleWsMessage(ws, message);
    } catch (e) {
      console.error('[WS] Invalid message:', e);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('[WS] Client disconnected. Total:', clients.size);
    state.clients.dashboards = clients.size;
    updateAudioReadyCount();
    broadcastToClients({ type: 'CLIENTS_UPDATE', clients: state.clients });
  });
});

function handleWsMessage(ws, message) {
  switch (message.type) {
    case 'DISMISS_ALARM':
      dismissAlarm();
      break;
    case 'AUDIO_READY':
      ws.isAudioReady = message.ready === true;
      updateAudioReadyCount();
      broadcastToClients({ type: 'CLIENTS_UPDATE', clients: state.clients });
      break;
    case 'AUDIO_PLAYED': {
      const id = message?.id;
      if (id && pendingAudioAcks.has(id)) {
        clearTimeout(pendingAudioAcks.get(id));
        pendingAudioAcks.delete(id);
      }
      break;
    }
    case 'UPDATE_SETTINGS':
      state.settings = {
        ...state.settings,
        ...message.settings,
        dndSchedule: { ...state.settings.dndSchedule, ...(message.settings?.dndSchedule || {}) },
        notifications: { ...state.settings.notifications, ...(message.settings?.notifications || {}) },
        sources: { ...state.settings.sources, ...(message.settings?.sources || {}) }
      };
      broadcastToClients({ type: 'SETTINGS_UPDATED', settings: state.settings });
      saveSettings();
      break;
    case 'TEST_NOTIFICATION':
      sendTestNotification();
      break;
    default:
      console.log('[WS] Unknown message type:', message.type);
  }
}

function broadcastToClients(data) {
  const message = JSON.stringify(data);
  clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

// ============ Notification Engine ============

function handleCompletion(source, duration, origin = null) {
  // Check if enabled and not DND
  if (!state.settings.enabled || state.settings.doNotDisturb || isWithinDndSchedule()) {
    console.log('[NOTIFY] Skipped - disabled or DND');
    return;
  }

  // Check if source is enabled
  if (state.settings.sources[source] && !state.settings.sources[source].enabled) {
    console.log(`[NOTIFY] Skipped - source ${source} disabled`);
    return;
  }

  // Record completion
  const completion = {
    id: Date.now(),
    source,
    timestamp: new Date().toISOString(),
    duration: duration || null
  };
  state.completions.unshift(completion);
  if (state.completions.length > MAX_COMPLETIONS) {
    state.completions = state.completions.slice(0, MAX_COMPLETIONS);
  }

  // Broadcast completion
  broadcastToClients({
    type: 'COMPLETION',
    completion
  });

  // Show desktop notification
  if (state.settings.notifications.desktop && origin !== 'extension') {
    showDesktopNotification(source);
  }

  if (state.settings.notifications.alarm) {
    startAlarm(source);
  } else if (state.settings.notifications.sound) {
    playSound();
  }
}

function refreshStaleSessions() {
  const now = Date.now();
  Object.entries(state.sessions).forEach(([id, session]) => {
    const last = session.lastActivity ? new Date(session.lastActivity).getTime() : 0;
    if (Number.isNaN(last) || !last) return;

    if (session.status === 'generating' && now - last > STALE_SESSION_MS) {
      session.status = 'idle';
      broadcastToClients({
        type: 'SESSION_UPDATE',
        source: id,
        status: 'idle',
        timestamp: new Date().toISOString()
      });
      return;
    }

    if ((session.status === 'complete' || session.status === 'ready') && now - last > STALE_READY_MS) {
      session.status = 'idle';
      broadcastToClients({
        type: 'SESSION_UPDATE',
        source: id,
        status: 'idle',
        timestamp: new Date().toISOString()
      });
    }
  });
}

function isBrowserSource(source) {
  return ['claude-ai', 'chatgpt', 'gemini', 'grok'].includes(source);
}

function getTerminalNotifierPath() {
  if (process.platform !== 'darwin') return null;
  const appPath = path.join(path.dirname(process.execPath), '..', 'Resources', 'notifier', 'terminal-notifier');
  if (fs.existsSync(appPath)) return appPath;
  const devPath = path.join(__dirname, '..', 'node_modules', 'node-notifier', 'vendor', 'terminal-notifier.app', 'Contents', 'MacOS', 'terminal-notifier');
  if (fs.existsSync(devPath)) return devPath;
  return null;
}

function showDesktopNotification(source) {
  const sourceNames = {
    'claude-ai': 'Claude',
    'chatgpt': 'ChatGPT',
    'gemini': 'Gemini',
    'grok': 'Grok',
    'claude-code': 'Claude Code',
    'codex': 'Codex'
  };

  const title = 'LLM Response Complete';
  const message = `${sourceNames[source] || source} has finished generating`;

  const notifierOptions = {
    title,
    message,
    sound: false,
    wait: true,
    timeout: 10,
    appID: 'com.llmnotifyhub.app'
  };

  const terminalNotifierPath = getTerminalNotifierPath();
  if (terminalNotifierPath) {
    notifierOptions.customPath = terminalNotifierPath;
  }

  notifier.notify(notifierOptions, (err, response, metadata) => {
    if (metadata?.activationType === 'clicked') {
      dismissAlarm();
    }
  });
}

function playSound() {
  // For now, use system beep. The dashboard will have full audio.
  // In a full implementation, we'd use a proper audio library
  console.log('[SOUND] Playing notification sound');

  const playSystemSoundFallback = () => {
    if (process.platform === 'darwin') {
      const soundPath = '/System/Library/Sounds/Glass.aiff';
      execFile('afplay', [soundPath], (err) => {
        if (!err) return;
        try {
          notifier.notify({
            title: 'LLM Notify Hub',
            message: 'Notification sound',
            sound: true,
            timeout: 3
          });
        } catch (e) {
          console.warn('[SOUND] Failed to play fallback sound:', e?.message || e);
        }
      });
      return;
    }

    try {
      notifier.notify({
        title: 'LLM Notify Hub',
        message: 'Notification sound',
        sound: true,
        timeout: 3
      });
    } catch (e) {
      console.warn('[SOUND] Failed to play fallback sound:', e?.message || e);
    }
  };

  const audioReady = state.clients.audioReady || 0;
  if (audioReady > 0) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeout = setTimeout(() => {
      pendingAudioAcks.delete(id);
      playSystemSoundFallback();
    }, 800);
    pendingAudioAcks.set(id, timeout);

    // Broadcast to dashboard to play sound
    broadcastToClients({
      type: 'PLAY_SOUND',
      id,
      preset: state.settings.notifications.soundPreset,
      volume: state.settings.notifications.alarmVolume
    });
    return;
  }

  playSystemSoundFallback();
}

function startAlarm(source) {
  state.alarm = {
    isActive: true,
    source,
    startTime: Date.now()
  };

  console.log('[ALARM] Started for', source);

  broadcastToClients({
    type: 'ALARM_START',
    source,
    preset: state.settings.notifications.soundPreset,
    volume: state.settings.notifications.alarmVolume
  });
}

function dismissAlarm() {
  if (state.alarm.isActive) {
    console.log('[ALARM] Dismissed');
    state.alarm = { isActive: false, source: null, startTime: null };

    broadcastToClients({
      type: 'ALARM_STOP'
    });
  }
}

function sendTestNotification() {
  console.log('[TEST] Sending test notification');

  notifier.notify({
    title: 'LLM Notify Hub - Test',
    message: 'Notifications are working!',
    sound: false,
    timeout: 5
  });

  if (state.settings.notifications.alarm) {
    startAlarm('test');
  } else if (state.settings.notifications.sound) {
    broadcastToClients({
      type: 'PLAY_SOUND',
      preset: state.settings.notifications.soundPreset,
      volume: state.settings.notifications.alarmVolume
    });
  }
}

// ============ Helpers ============

function normalizeSource(source) {
  const mapping = {
    'claude': 'claude-ai',
    'claude.ai': 'claude-ai',
    'claudeai': 'claude-ai',
    'chatgpt': 'chatgpt',
    'chat.openai.com': 'chatgpt',
    'openai': 'chatgpt',
    'gemini': 'gemini',
    'gemini.google.com': 'gemini',
    'grok': 'grok',
    'grok.com': 'grok',
    'claude-code': 'claude-code',
    'claudecode': 'claude-code',
    'vscode': 'claude-code',
    'codex': 'codex',
    'openai-codex': 'codex'
  };
  return mapping[source.toLowerCase()] || source.toLowerCase();
}

function isWithinDndSchedule() {
  const schedule = state.settings?.dndSchedule;
  if (!schedule?.enabled) return false;
  const [startH, startM] = schedule.start.split(':').map(Number);
  const [endH, endM] = schedule.end.split(':').map(Number);
  if (Number.isNaN(startH) || Number.isNaN(endH)) return false;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + (startM || 0);
  const endMinutes = endH * 60 + (endM || 0);

  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

// ============ Start Server ============

server.listen(PORT, HOST, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║           LLM Notify Hub Server                   ║
╠═══════════════════════════════════════════════════╣
║  Dashboard:  http://localhost:${PORT}               ║
║  API:        http://localhost:${PORT}/api           ║
║  WebSocket:  ws://localhost:${PORT}                 ║
╚═══════════════════════════════════════════════════╝
  `);

  // Auto-open dashboard in browser
  const openBrowser = (url) => {
    const { exec } = require('child_process');
    if (process.platform === 'darwin') {
      exec(`open "${url}"`);
    } else if (process.platform === 'win32') {
      exec(`start "" "${url}"`);
    } else {
      exec(`xdg-open "${url}"`);
    }
  };

  // Try native command first (more reliable when packaged), fallback to open package
  try {
    openBrowser(`http://localhost:${PORT}`);
  } catch {
    import('open').then(({ default: open }) => {
      open(`http://localhost:${PORT}`);
    }).catch(() => {});
  }
});

setInterval(refreshStaleSessions, 60 * 1000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[SERVER] Shutting down...');
  wss.close();
  server.close();
  process.exit(0);
});
