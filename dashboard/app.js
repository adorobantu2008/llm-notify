// LLM Notify Hub Dashboard

const App = (() => {
  let ws = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 10;
  const RECONNECT_DELAY = 2000;

  // State
  let state = {
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
    alarm: { isActive: false },
    clients: { dashboards: 0 }
  };

  let usageRangeHours = parseInt(localStorage.getItem('usageRangeHours') || '24', 10);
  const tabId = Math.random().toString(36).slice(2);
  let isPrimaryTab = false;
  let pendingSoundEvent = null;
  let audioReady = false;
  const SESSION_IDLE_AFTER_MS = 3 * 60 * 1000;
  let sessionMenuEl = null;
  const pendingSourceUpdates = new Map();

  // Session display config
  const sessionConfig = {
    'claude-ai': {
      name: 'Claude',
      type: 'Web',
      svg: '<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/>' // Placeholder, real logos would go here ideally 
    },
    'chatgpt': {
      name: 'ChatGPT',
      type: 'Web',
      svg: '<path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/><circle cx="12" cy="12" r="5"/>'
    },
    'gemini': {
      name: 'Gemini',
      type: 'Web',
      svg: '<path d="M12 2L2 12l10 10 10-10L12 2zm0 18l-8-8 8-8 8 8-8 8z"/>'
    },
    'grok': {
      name: 'Grok',
      type: 'Web',
      svg: '<rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 8l8 8M16 8l-8 8" stroke="currentColor" stroke-width="2"/>'
    },
    'claude-code': {
      name: 'Claude Code',
      type: 'VS Code',
      svg: '<path d="M9.7 7.7c-0.4-0.4-1-0.4-1.4 0s-0.4 1 0 1.4l3.3 3.3L8.3 15.7c-0.4 0.4-0.4 1 0 1.4s1 0.4 1.4 0l4-4c0.4-0.4 0.4-1 0-1.4L9.7 7.7z"/>'
    },
    'codex': {
      name: 'Codex',
      type: 'VS Code',
      svg: '<path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>'
    }
  };

  const sourceColors = {
    'claude-ai': '#D4A574',
    'chatgpt': '#10A37F',
    'gemini': '#4285F4',
    'grok': '#0F172A',
    'claude-code': '#7C3AED',
    'codex': '#EA580C'
  };

  function getSessionEntries() {
    return Object.keys(state.sessions || {}).filter(id => state.settings?.sources?.[id]?.hidden !== true);
  }

  function getSessionMeta(id) {
    const base = sessionConfig[id];
    if (base) return base;
    const session = state.sessions?.[id];
    const override = state.settings?.sources?.[id] || {};
    const name = override.displayName || session?.displayName || id;
    const icon = name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
    return { name, icon: icon || '?', type: session?.source || 'Web' };
  }

  function getSourceColor(id) {
    const override = state.settings?.sources?.[id];
    if (override?.color) return override.color;
    if (sourceColors[id]) return sourceColors[id];
    const hash = Array.from(id).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const hue = hash % 360;
    return `hsl(${hue} 70% 55%)`;
  }

  // ============ WebSocket ============

  function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[WS] Connected');
      reconnectAttempts = 0;
      updateConnectionStatus('connected');
      send({ type: 'AUDIO_READY', ready: audioReady });
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      updateConnectionStatus('disconnected');
      attemptReconnect();
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleMessage(message);
      } catch (e) {
        console.error('[WS] Invalid message:', e);
      }
    };
  }

  async function fetchStateOnce() {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) return;
      state = await res.json();
      renderAll();
    } catch {
      // ignore fetch errors
    }
  }

  function attemptReconnect() {
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      console.log(`[WS] Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      updateConnectionStatus('connecting');
      setTimeout(connect, RECONNECT_DELAY);
    } else {
      console.error('[WS] Max reconnection attempts reached');
    }
  }

  function send(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function setAudioReady(ready) {
    const next = ready === true;
    if (audioReady === next) return;
    audioReady = next;
    send({ type: 'AUDIO_READY', ready: audioReady });
  }

  function handleMessage(message) {
    switch (message.type) {
      case 'INIT':
        state = message.state;
        renderAll();
        break;

      case 'SESSION_UPDATE':
        if (state.sessions[message.source]) {
          state.sessions[message.source].status = message.status;
          state.sessions[message.source].lastActivity = message.timestamp;
        }
        renderSessions();
        break;

      case 'COMPLETION':
        state.completions.unshift(message.completion);
        if (state.completions.length > 50) {
          state.completions = state.completions.slice(0, 50);
        }
        renderCompletions();
        drawUsageChart();
        renderUsageMetrics();
        renderUsageTable();
        break;

      case 'SETTINGS_UPDATED':
        state.settings = message.settings;
        renderSettings();
        break;

      case 'PLAY_SOUND':
        console.log('[AUDIO] Received PLAY_SOUND:', message.preset, message.volume);
        (async () => {
          try {
            const ctx = AudioEngine.getContext();
            if (ctx.state === 'suspended') {
              console.log('[AUDIO] Context suspended, attempting unlock');
              const state = await AudioEngine.unlock();
              if (state !== 'running') {
                console.log('[AUDIO] Unlock blocked, waiting for user gesture');
                pendingSoundEvent = { type: 'sound', preset: message.preset, volume: message.volume };
                setAudioReady(false);
                return;
              }
            }
            console.log('[AUDIO] Playing sound...');
            setAudioReady(true);
            AudioEngine.playTone(message.preset, message.volume);
            if (message.id) {
              send({ type: 'AUDIO_PLAYED', id: message.id });
            }
          } catch (e) {
            console.error('[AUDIO] Error playing sound:', e);
          }
        })();
        break;

      case 'ALARM_START':
        state.alarm = { isActive: true, source: message.source };
        console.log('[AUDIO] Received ALARM_START:', message.preset, message.volume);
        (async () => {
          try {
            const ctx = AudioEngine.getContext();
            if (ctx.state === 'suspended') {
              console.log('[AUDIO] Context suspended, attempting unlock for alarm');
              const state = await AudioEngine.unlock();
              if (state !== 'running') {
                console.log('[AUDIO] Unlock blocked, waiting for user gesture');
                pendingSoundEvent = { type: 'alarm', preset: message.preset, volume: message.volume };
                setAudioReady(false);
                return;
              }
            }
            console.log('[AUDIO] Starting alarm loop...');
            setAudioReady(true);
            AudioEngine.startLoop(message.preset, message.volume);
          } catch (e) {
            console.error('[AUDIO] Error starting alarm:', e);
          }
        })();
        renderAlarm();
        break;

      case 'ALARM_STOP':
        state.alarm = { isActive: false };
        if (isPrimaryTab) {
          AudioEngine.stopLoop();
        }
        renderAlarm();
        break;

      case 'CLIENTS_UPDATE':
        state.clients = message.clients;
        renderDevices();
        break;

      default:
        console.log('[WS] Unknown message:', message.type);
    }
  }

  // ============ Rendering ============

  function renderAll() {
    renderSessions();
    renderSettings();
    renderCompletions();
    renderSources();
    renderUsage();
    renderDevices();
    renderAlarm();
    startUptimeCounter();
  }

  function getDerivedSessionStatus(session) {
    const status = (session?.status || 'idle').toLowerCase();
    if (status === 'generating') return 'generating';
    const last = session?.lastActivity ? new Date(session.lastActivity).getTime() : 0;
    if (!last || Date.now() - last > SESSION_IDLE_AFTER_MS) return 'idle';
    if (status === 'complete' || status === 'ready') return 'ready';
    return status;
  }

  function renderSessions() {
    const grid = document.getElementById('sessions-grid');
    if (!grid) return;

    if (!getSessionEntries().length) {
      grid.innerHTML = '<div class="empty-state">No active sessions yet</div>';
      return;
    }

    const sorted = getSessionEntries().map((id) => {
      const session = state.sessions[id];
      const derivedStatus = getDerivedSessionStatus(session);
      const last = session?.lastActivity ? new Date(session.lastActivity).getTime() : 0;
      return { id, session, derivedStatus, last };
    }).sort((a, b) => {
      const rank = (s) => s === 'generating' ? 0 : s === 'ready' ? 1 : 2;
      const r = rank(a.derivedStatus) - rank(b.derivedStatus);
      if (r !== 0) return r;
      return (b.last || 0) - (a.last || 0);
    });

    grid.innerHTML = sorted.map(({ id, session, derivedStatus }) => {
      const config = getSessionMeta(id);
      const color = getSourceColor(id);
      const iconContent = config.svg
        ? `<svg viewBox="0 0 24 24" fill="currentColor">${config.svg}</svg>`
        : (config.icon || '?');

      return `
        <div class="session-item" data-session-id="${id}">
          <div class="session-icon ${id}" style="background:${color}; color:#fff;">
            ${iconContent}
          </div>
          <div class="session-info">
            <div class="session-name">${config.name}</div>
            <div class="session-status ${derivedStatus}">
              ${formatStatus(derivedStatus)}
              ${session.lastActivity ? ` • ${formatTimeAgo(session.lastActivity)}` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    grid.querySelectorAll('.session-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = item.dataset.sessionId;
        if (!id) return;
        openSessionMenu(id, item);
      });
    });
  }

  function renderSettings() {
    // Master toggles
    document.getElementById('enabled').checked = state.settings.enabled;
    document.getElementById('dndScheduleEnabled').checked = !!state.settings.dndSchedule?.enabled;
    document.getElementById('dndStart').value = state.settings.dndSchedule?.start || '22:00';
    document.getElementById('dndEnd').value = state.settings.dndSchedule?.end || '07:00';

    // Notification settings
    document.getElementById('desktop').checked = state.settings.notifications.desktop;
    document.getElementById('sound').checked = state.settings.notifications.sound;
    document.getElementById('soundPreset').value = state.settings.notifications.soundPreset;
    document.getElementById('alarm').checked = state.settings.notifications.alarm;
    document.getElementById('volume').value = state.settings.notifications.alarmVolume ?? 0.3;
    updateVolumeLabel();

    // Show/hide sound options
    updateSoundOptionVisibility();
  }

  function renderCompletions() {
    const list = document.getElementById('completions-list');
    if (!list) return;

    if (state.completions.length === 0) {
      list.innerHTML = '<div class="empty-state">No completions yet</div>';
      return;
    }

    list.innerHTML = state.completions.slice(0, 20).map(completion => {
      const config = getSessionMeta(completion.source);
      const color = getSourceColor(completion.source);
      const iconContent = config.svg
        ? `<svg viewBox="0 0 24 24" fill="currentColor">${config.svg}</svg>`
        : (config.icon || '?');

      return `
        <div class="completion-item">
          <div class="completion-icon session-icon ${completion.source}" style="background:${color}; color:#fff;">
            ${iconContent}
          </div>
          <div class="completion-info">
            <div class="completion-source">${config.name}</div>
            <div class="completion-time">${formatTime(completion.timestamp)}</div>
          </div>
          ${completion.duration ? `<div class="completion-duration">${formatDuration(completion.duration)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  function renderSources() {
    const list = document.getElementById('sources-list');
    if (!list) return;

    if (!getSessionEntries().length) {
      list.innerHTML = '<div class="empty-state">No sources yet</div>';
      return;
    }

    list.innerHTML = getSessionEntries().map((id) => {
      const config = getSessionMeta(id);
      const enabled = state.settings.sources[id]?.enabled !== false;
      const iconContent = config.svg
        ? `<svg viewBox="0 0 24 24" fill="currentColor">${config.svg}</svg>`
        : (config.icon || '?');
      return `
        <div class="source-item">
          <div class="source-info">
            <div class="source-icon session-icon ${id}" style="background:${getSourceColor(id)}; color:#fff;">${iconContent}</div>
            <div>
              <div class="source-name">${config.name}</div>
              <div class="source-type">${config.type}</div>
            </div>
          </div>
          <label class="toggle">
            <input type="checkbox" data-source="${id}" ${enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      `;
    }).join('');

    // Add event listeners
    list.querySelectorAll('input[data-source]').forEach(input => {
      input.addEventListener('change', (e) => {
        const source = e.target.dataset.source;
        if (!state.settings.sources[source]) {
          state.settings.sources[source] = {};
        }
        state.settings.sources[source].enabled = e.target.checked;
        send({ type: 'UPDATE_SETTINGS', settings: state.settings });
      });
    });
  }

  function renderUsage() {
    const chart = document.getElementById('usage-chart');
    if (!chart) return;
    const ctx = chart.getContext('2d');
    if (!ctx) return;

    const usageToggles = document.getElementById('usage-toggles');
    const sourceIds = getUsageSourceIds();
    if (!sourceIds.length) {
      usageToggles.innerHTML = '<div class="empty-state">No sources yet</div>';
      ctx.clearRect(0, 0, chart.width, chart.height);
      renderUsageMetrics();
      renderUsageTable();
      return;
    }

    usageToggles.innerHTML = sourceIds.map((id) => {
      const config = getSessionMeta(id);
      const color = getSourceColor(id);
      const usageEnabled = state.settings?.sources?.[id]?.usageEnabled !== false;
      return `
        <label class="usage-toggle" data-active="true">
          <input type="checkbox" data-usage="${id}" ${usageEnabled ? 'checked' : ''}>
          <span class="usage-swatch" style="background:${color}"></span>
          <span class="usage-label">${config.name}</span>
        </label>
      `;
    }).join('');

    usageToggles.querySelectorAll('input[data-usage]').forEach(input => {
      input.addEventListener('change', (e) => {
        const label = e.target.closest('.usage-toggle');
        label.dataset.active = e.target.checked ? 'true' : 'false';
        const id = e.target.dataset.usage;
        if (!state.settings.sources[id]) state.settings.sources[id] = {};
        state.settings.sources[id].usageEnabled = e.target.checked;
        send({ type: 'UPDATE_SETTINGS', settings: state.settings });
        drawUsageChart();
        renderUsageMetrics();
        renderUsageTable();
      });
    });

    drawUsageChart();
    renderUsageMetrics();
    renderUsageTable();
  }

  function getUsageSourceIds() {
    const ids = new Set();
    getSessionEntries().forEach(id => ids.add(id));
    (state.completions || []).forEach(c => {
      if (c?.source) ids.add(c.source);
    });
    return Array.from(ids);
  }

  function getActiveUsageSources() {
    const ids = getUsageSourceIds();
    const active = ids.filter(id => state.settings?.sources?.[id]?.usageEnabled !== false);
    return active.length ? active : ids;
  }

  function renderDevices() {
    const list = document.getElementById('devices-list');
    if (!list) return;

    const dashboards = state.clients?.dashboards ?? 0;
    list.innerHTML = `
      <div class="device-item">
        <div class="device-meta">
          <div class="device-name">Local Hub</div>
          <div class="device-desc">localhost • primary controller</div>
        </div>
        <div class="device-status">Active</div>
      </div>
      <div class="device-item">
        <div class="device-meta">
          <div class="device-name">Dashboard Clients</div>
          <div class="device-desc">${dashboards} connected</div>
        </div>
        <div class="device-status">${dashboards > 0 ? 'Online' : 'Idle'}</div>
      </div>
    `;
  }

  function renderAlarm() {
    const banner = document.getElementById('alarm-banner');
    const sourceText = document.getElementById('alarm-source');

    if (state.alarm.isActive) {
      banner.classList.add('active');
      const config = getSessionMeta(state.alarm.source);
      sourceText.textContent = `${config.name} response complete!`;
    } else {
      banner.classList.remove('active');
    }
  }

  function updateConnectionStatus(status) {
    const el = document.getElementById('connection-status');
    const text = el.querySelector('.status-text');

    el.className = 'connection-status ' + status;

    switch (status) {
      case 'connected':
        text.textContent = 'Connected';
        break;
      case 'disconnected':
        text.textContent = 'Disconnected';
        break;
      case 'connecting':
        text.textContent = 'Connecting...';
        break;
    }
  }

  // ============ Helpers ============

  function formatStatus(status) {
    const map = {
      'idle': 'Idle',
      'generating': 'Generating...',
      'complete': 'Ready',
      'ready': 'Ready'
    };
    return map[status] || status;
  }

  function formatTimeAgo(timestamp) {
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    const diff = Math.floor((now - then) / 1000);

    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function updateSourceSettings(id, patch) {
    if (!state.settings.sources[id]) {
      state.settings.sources[id] = {};
    }
    state.settings.sources[id] = { ...state.settings.sources[id], ...patch };
    send({ type: 'UPDATE_SETTINGS', settings: state.settings });
  }

  function scheduleSourceUpdate(id, patch) {
    const next = { ...(pendingSourceUpdates.get(id) || {}), ...patch };
    pendingSourceUpdates.set(id, next);
    if (next._timer) clearTimeout(next._timer);
    next._timer = setTimeout(() => {
      const payload = { ...next };
      delete payload._timer;
      pendingSourceUpdates.delete(id);
      updateSourceSettings(id, payload);
    }, 80);
    pendingSourceUpdates.set(id, next);
  }

  function applyLocalSourceUpdate(id, patch) {
    if (!state.settings.sources[id]) {
      state.settings.sources[id] = {};
    }
    state.settings.sources[id] = { ...state.settings.sources[id], ...patch };
  }

  function closeSessionMenu() {
    if (sessionMenuEl) {
      sessionMenuEl.remove();
      sessionMenuEl = null;
    }
  }

  function openSessionMenu(id, anchorEl) {
    closeSessionMenu();
    const config = getSessionMeta(id);
    const override = state.settings?.sources?.[id] || {};
    const colorValue = override.color && override.color.startsWith('#') ? override.color : '#22d3ee';
    const palette = ['#22d3ee', '#10b981', '#f59e0b', '#f97316', '#ef4444', '#a855f7', '#3b82f6', '#64748b'];

    const rect = anchorEl.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'session-menu';
    menu.style.top = `${Math.min(window.innerHeight - 220, rect.bottom + 8)}px`;
    menu.style.left = `${Math.min(window.innerWidth - 260, rect.left)}px`;
    menu.innerHTML = `
      <div class="session-menu-title">Session</div>
      <label class="session-menu-field">
        <span>Name</span>
        <input type="text" value="${config.name}" data-name-input />
      </label>
      <div class="session-menu-field">
        <span>Color</span>
        <div class="session-color-row">
          <div class="session-color-swatches">
            ${palette.map(color => `
              <button class="color-swatch-btn ${color === colorValue ? 'active' : ''}" data-color-swatch="${color}" style="background:${color}"></button>
            `).join('')}
          </div>
          <input class="session-color-input" type="text" value="${colorValue}" data-color-input />
        </div>
      </div>
      <div class="session-menu-actions">
        <button class="ghost-btn" data-remove-btn>Remove</button>
        <button class="ghost-btn" data-close-btn>Close</button>
      </div>
    `;
    document.body.appendChild(menu);
    sessionMenuEl = menu;
    menu.addEventListener('click', (e) => e.stopPropagation());

    const nameInput = menu.querySelector('[data-name-input]');
    const colorInput = menu.querySelector('[data-color-input]');
    const removeBtn = menu.querySelector('[data-remove-btn]');
    const closeBtn = menu.querySelector('[data-close-btn]');

    nameInput.addEventListener('input', (e) => {
      const value = e.target.value.trim();
      if (!value) return;
      applyLocalSourceUpdate(id, { displayName: value });
      scheduleSourceUpdate(id, { displayName: value });
      renderSessions();
      renderSources();
      renderUsage();
    });

    const swatches = menu.querySelectorAll('[data-color-swatch]');
    swatches.forEach(btn => {
      btn.addEventListener('mousedown', (event) => {
        event.preventDefault();
        const value = btn.getAttribute('data-color-swatch');
        if (!value) return;
        colorInput.value = value;
        applyLocalSourceUpdate(id, { color: value });
        scheduleSourceUpdate(id, { color: value });
        renderSessions();
        renderSources();
        renderUsage();
        swatches.forEach(s => s.classList.toggle('active', s === btn));
      });
    });

    colorInput.addEventListener('input', (e) => {
      const value = e.target.value;
      if (!/^#?[0-9a-f]{3,6}$/i.test(value)) return;
      const normalized = value.startsWith('#') ? value : `#${value}`;
      applyLocalSourceUpdate(id, { color: normalized });
      scheduleSourceUpdate(id, { color: normalized });
      renderSessions();
      renderSources();
      renderUsage();
    });

    removeBtn.addEventListener('click', () => {
      updateSourceSettings(id, { hidden: true, enabled: false });
      closeSessionMenu();
      renderAll();
    });

    closeBtn.addEventListener('click', closeSessionMenu);
  }

  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return `${minutes}m ${remaining}s`;
  }

  function drawUsageChart() {
    const canvas = document.getElementById('usage-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const tooltip = document.getElementById('usage-tooltip');

    const width = canvas.width = canvas.parentElement.clientWidth - 24;
    const height = canvas.height = 140;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = 'rgba(15, 23, 42, 0.04)';
    ctx.fillRect(0, 0, width, height);

    const end = Date.now();
    const start = end - usageRangeHours * 60 * 60 * 1000;
    const buckets = usageRangeHours <= 24 ? 24 : 36;
    const bucketMs = (end - start) / buckets;

    const activeSources = new Set(getActiveUsageSources());

    const series = {};
    activeSources.forEach(id => {
      series[id] = new Array(buckets).fill(0);
    });

    state.completions.forEach(c => {
      if (!activeSources.has(c.source)) return;
      const t = new Date(c.timestamp).getTime();
      if (t < start || t > end) return;
      const index = Math.min(buckets - 1, Math.floor((t - start) / bucketMs));
      series[c.source][index] += 1;
    });

    const maxValue = Math.max(1, ...Object.values(series).flat());
    const yStep = Math.max(1, Math.ceil(maxValue / 4));
    const yMax = yStep * 4;
    const plotTop = 10;
    const plotBottom = height - 20;
    const plotLeft = 30;
    const plotRight = width - 6;

    // Grid
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = plotTop + ((plotBottom - plotTop) / 4) * i;
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
    }

    // Y axis labels
    ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
    ctx.font = '11px IBM Plex Sans, sans-serif';
    for (let i = 0; i <= 4; i++) {
      const value = yMax - yStep * i;
      const y = plotTop + ((plotBottom - plotTop) / 4) * i + 4;
      ctx.fillText(`${value}`, 4, y);
    }

    // X axis labels
    const labelCount = 4;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
    for (let i = 0; i <= labelCount; i++) {
      const fraction = i / labelCount;
      const idx = Math.min(buckets - 1, Math.round(fraction * (buckets - 1)));
      const x = plotLeft + ((plotRight - plotLeft) / (buckets - 1)) * idx;
      let label;
      if (usageRangeHours >= 168) {
        label = `${Math.round((usageRangeHours * fraction) / 24)}d`;
      } else if (usageRangeHours <= 3) {
        label = `${Math.round(usageRangeHours * fraction * 60)}m`;
      } else {
        label = `${Math.round(usageRangeHours * fraction)}h`;
      }
      ctx.fillText(label, x - 8, height - 4);
    }

    const lastPoints = [];
    for (const [source, values] of Object.entries(series)) {
      const color = getSourceColor(source);
      const gradient = ctx.createLinearGradient(0, plotTop, 0, plotBottom);
      gradient.addColorStop(0, `${color}55`);
      gradient.addColorStop(1, `${color}08`);

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      values.forEach((v, i) => {
        const x = plotLeft + ((plotRight - plotLeft) / (buckets - 1)) * i;
        const y = plotBottom - (v / yMax) * (plotBottom - plotTop);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // No area fill to avoid "additive" look across series
      ctx.closePath();

      // Highlight last point
      const lastIndex = values.length - 1;
      const lastX = plotLeft + ((plotRight - plotLeft) / (buckets - 1)) * lastIndex;
      const lastY = plotBottom - (values[lastIndex] / yMax) * (plotBottom - plotTop);
      lastPoints.push({ x: lastX, y: lastY, value: values[lastIndex], source });
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Tooltip hover
    canvas.onmousemove = (e) => {
      if (!tooltip) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < plotLeft || x > plotRight || y < plotTop || y > plotBottom) {
        tooltip.style.opacity = '0';
        return;
      }
      const bucketIndex = Math.min(buckets - 1, Math.max(0, Math.round(((x - plotLeft) / (plotRight - plotLeft)) * (buckets - 1))));
      const bucketTime = new Date(start + bucketIndex * bucketMs);
      const totalAtBucket = Object.values(series).reduce((acc, values) => acc + (values[bucketIndex] || 0), 0);
      if (totalAtBucket > 0) {
        tooltip.style.opacity = '1';
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${plotTop}px`;
        const label = usageRangeHours >= 168
          ? bucketTime.toLocaleDateString([], { month: 'short', day: 'numeric' })
          : bucketTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        tooltip.textContent = `${label} • ${totalAtBucket} calls`;
      } else {
        tooltip.style.opacity = '0';
      }
    };
  }


  function renderUsageMetrics() {
    const target = document.getElementById('usage-metrics');
    if (!target) return;

    const activeSources = new Set(getActiveUsageSources());

    const end = Date.now();
    const start = end - usageRangeHours * 60 * 60 * 1000;
    const completions = state.completions.filter(c => {
      if (activeSources.size && !activeSources.has(c.source)) return false;
      const t = new Date(c.timestamp).getTime();
      return t >= start && t <= end;
    });

    const total = completions.length;
    const sourcesUsed = new Set(completions.map(c => c.source)).size;
    const hourly = new Array(usageRangeHours).fill(0);
    completions.forEach(c => {
      const t = new Date(c.timestamp).getTime();
      const idx = Math.min(usageRangeHours - 1, Math.max(0, Math.floor((t - start) / (60 * 60 * 1000))));
      hourly[idx] += 1;
    });
    const peak = Math.max(0, ...hourly);

    target.innerHTML = `
      <div class="usage-metric">
        <div class="usage-metric-label">Total Calls</div>
        <div class="usage-metric-value">${total}</div>
      </div>
      <div class="usage-metric">
        <div class="usage-metric-label">Active Sources</div>
        <div class="usage-metric-value">${sourcesUsed}</div>
      </div>
      <div class="usage-metric">
        <div class="usage-metric-label">Peak Hour</div>
        <div class="usage-metric-value">${peak}</div>
      </div>
    `;
  }

  function renderUsageTable() {
    const target = document.getElementById('usage-table');
    if (!target) return;

    const end = Date.now();
    const start = end - usageRangeHours * 60 * 60 * 1000;
    const grouped = {};
    state.completions.forEach(c => {
      const t = new Date(c.timestamp).getTime();
      if (t < start || t > end) return;
      if (!grouped[c.source]) grouped[c.source] = [];
      grouped[c.source].push(c);
    });

    const rows = Object.entries(grouped)
      .map(([source, items]) => {
        const last = items[0];
        return { source, count: items.length, last: last?.timestamp };
      })
      .sort((a, b) => b.count - a.count);

    target.innerHTML = `
      <div class="usage-table-header">
        <div>Source</div>
        <div>Calls</div>
        <div>Last Seen</div>
        <div></div>
      </div>
      ${rows.map(row => {
      const name = getSessionMeta(row.source).name;
      const color = getSourceColor(row.source);
      return `
          <div class="usage-table-row">
            <div class="usage-source">
              <span class="usage-swatch" style="background:${color}"></span>
              ${name}
            </div>
            <div class="usage-count">${row.count}</div>
            <div class="usage-last">${row.last ? formatTime(row.last) : '--'}</div>
            <button class="usage-export" data-export="${row.source}">Export</button>
          </div>
        `;
    }).join('')}
    `;

    target.querySelectorAll('button[data-export]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const source = e.target.dataset.export;
        exportUsageCsv(source);
      });
    });
  }

  let uptimeInterval;
  function startUptimeCounter() {
    const el = document.getElementById('uptime');
    if (uptimeInterval) clearInterval(uptimeInterval);

    const startTime = Date.now();
    uptimeInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const hours = Math.floor(elapsed / 3600);
      const minutes = Math.floor((elapsed % 3600) / 60);
      const seconds = elapsed % 60;
      el.textContent = `Uptime: ${hours}h ${minutes}m ${seconds}s`;
    }, 1000);
  }

  // ============ Event Handlers ============

  function setupEventListeners() {
    // Theme toggle
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const html = document.documentElement;
      const current = html.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
    });

    // Load saved theme
    const savedTheme = localStorage.getItem('theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', savedTheme);

    // Settings toggles
    ['enabled', 'desktop', 'sound', 'alarm'].forEach(id => {
      document.getElementById(id).addEventListener('change', (e) => {
        if (id === 'enabled') {
          state.settings[id] = e.target.checked;
        } else {
          state.settings.notifications[id] = e.target.checked;
        }
        send({ type: 'UPDATE_SETTINGS', settings: state.settings });

        if (id === 'sound' || id === 'alarm') {
          updateSoundOptionVisibility();
        }
      });
    });

    // DND schedule
    ['dndScheduleEnabled', 'dndStart', 'dndEnd'].forEach(id => {
      document.getElementById(id).addEventListener('change', (e) => {
        if (!state.settings.dndSchedule) {
          state.settings.dndSchedule = { enabled: false, start: '22:00', end: '07:00' };
        }
        if (id === 'dndScheduleEnabled') {
          state.settings.dndSchedule.enabled = e.target.checked;
        } else if (id === 'dndStart') {
          state.settings.dndSchedule.start = e.target.value;
        } else if (id === 'dndEnd') {
          state.settings.dndSchedule.end = e.target.value;
        }
        send({ type: 'UPDATE_SETTINGS', settings: state.settings });
      });
    });

    // Sound preset
    document.getElementById('soundPreset').addEventListener('change', (e) => {
      state.settings.notifications.soundPreset = e.target.value;
      send({ type: 'UPDATE_SETTINGS', settings: state.settings });
    });

    // Preview sound
    document.getElementById('preview-sound').addEventListener('click', async () => {
      await AudioEngine.unlock();
      const preset = document.getElementById('soundPreset').value;
      AudioEngine.playTone(preset, state.settings.notifications.alarmVolume ?? 0.3);
    });

    // Volume slider
    document.getElementById('volume').addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      state.settings.notifications.alarmVolume = val;
      updateVolumeLabel();
      send({ type: 'UPDATE_SETTINGS', settings: state.settings });
      if (state.alarm.isActive) {
        AudioEngine.startLoop(state.settings.notifications.soundPreset, val);
      }
    });

    // Launch at Login
    document.getElementById('launchAtLogin').addEventListener('change', (e) => {
      setLaunchAtLogin(e.target.checked);
    });

    // Test notification
    document.getElementById('test-notification').addEventListener('click', async () => {
      // Unlock audio context during user gesture before sending message
      // This is required because browser autoplay policy needs direct user interaction
      try {
        await AudioEngine.unlock();
      } catch (e) {
        console.log('[AUDIO] Could not unlock during test click:', e);
      }
      send({ type: 'TEST_NOTIFICATION' });
    });

    // Usage controls
    const resetModal = document.getElementById('confirm-reset');
    document.getElementById('reset-usage').addEventListener('click', () => {
      resetModal.classList.add('active');
    });

    document.getElementById('cancel-reset').addEventListener('click', () => {
      resetModal.classList.remove('active');
    });

    document.getElementById('confirm-reset-btn').addEventListener('click', () => {
      state.completions = [];
      drawUsageChart();
      renderUsageMetrics();
      renderUsageTable();
      renderCompletions();
      resetModal.classList.remove('active');
    });

    document.getElementById('toggle-usage').addEventListener('click', () => {
      const card = document.querySelector('.usage-card');
      if (!card) return;
      const collapsed = card.classList.toggle('collapsed');
      document.getElementById('toggle-usage').textContent = collapsed ? 'Expand' : 'Collapse';
      localStorage.setItem('usageCollapsed', collapsed ? '1' : '0');
    });

    // Dismiss alarm
    document.getElementById('dismiss-alarm').addEventListener('click', () => {
      send({ type: 'DISMISS_ALARM' });
    });

    // Toggle history list
    document.getElementById('toggle-history').addEventListener('click', () => {
      const list = document.getElementById('completions-list');
      const btn = document.getElementById('toggle-history');
      const isHidden = list.classList.toggle('collapsed');
      btn.textContent = isHidden ? 'Show' : 'Hide';
      localStorage.setItem('historyCollapsed', isHidden ? '1' : '0');
    });

    document.addEventListener('click', closeSessionMenu);

    // Unlock audio on first user gesture (fixes "must preview sound" issue)
    const gestureUnlock = async () => {
      await unlockAudioAndReplay();
      document.removeEventListener('pointerdown', gestureUnlock);
      document.removeEventListener('keydown', gestureUnlock);
    };
    document.addEventListener('pointerdown', gestureUnlock, { capture: true });
    document.addEventListener('keydown', gestureUnlock, { capture: true });
  }

  // ============ Init ============

  async function fetchLaunchAtLogin() {
    try {
      const res = await fetch('/api/launch-at-login');
      const data = await res.json();
      const toggle = document.getElementById('launchAtLogin');
      const row = toggle?.closest('.setting-row');

      if (!data.supported) {
        // Hide the option on non-macOS
        if (row) row.style.display = 'none';
      } else {
        toggle.checked = data.enabled;
      }
    } catch (e) {
      console.error('[SETTINGS] Failed to fetch launch at login:', e);
    }
  }

  async function setLaunchAtLogin(enabled) {
    try {
      const res = await fetch('/api/launch-at-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      const data = await res.json();
      if (!data.success) {
        console.error('[SETTINGS] Failed to set launch at login:', data.error);
        // Revert the toggle
        document.getElementById('launchAtLogin').checked = !enabled;
      }
    } catch (e) {
      console.error('[SETTINGS] Failed to set launch at login:', e);
      document.getElementById('launchAtLogin').checked = !enabled;
    }
  }

  function init() {
    setupEventListeners();
    connect();
    fetchLaunchAtLogin();

    const collapsed = localStorage.getItem('historyCollapsed') === '1';
    if (collapsed) {
      document.getElementById('completions-list').classList.add('collapsed');
      document.getElementById('toggle-history').textContent = 'Show';
    }

    const usageCollapsed = localStorage.getItem('usageCollapsed') === '1';
    if (usageCollapsed) {
      const card = document.querySelector('.usage-card');
      if (card) card.classList.add('collapsed');
      const btn = document.getElementById('toggle-usage');
      if (btn) btn.textContent = 'Expand';
    }

    initPrimaryTabLock();

    document.querySelectorAll('.seg-btn').forEach(btn => {
      const hours = parseInt(btn.dataset.range, 10);
      if (hours === usageRangeHours) btn.classList.add('active');
      btn.addEventListener('click', () => {
        usageRangeHours = hours;
        localStorage.setItem('usageRangeHours', String(hours));
        document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        drawUsageChart();
        renderUsageMetrics();
        renderUsageTable();
      });
    });
  }

  function initPrimaryTabLock() {
    const primaryKey = 'llmNotifyPrimaryId';
    const primaryTsKey = 'llmNotifyPrimaryTs';
    const heartbeatMs = 2000;
    const staleMs = 5000;

    const attemptTakePrimary = () => {
      const now = Date.now();
      const currentId = localStorage.getItem(primaryKey);
      const currentTs = parseInt(localStorage.getItem(primaryTsKey) || '0', 10);
      const isStale = now - currentTs > staleMs;
      const shouldTake = !currentId || isStale || (document.visibilityState === 'visible' && currentId !== tabId);

      if (shouldTake) {
        localStorage.setItem(primaryKey, tabId);
        localStorage.setItem(primaryTsKey, String(now));
        isPrimaryTab = true;
      } else {
        isPrimaryTab = currentId === tabId;
      }
    };

    attemptTakePrimary();
    setInterval(() => {
      if (isPrimaryTab) {
        localStorage.setItem(primaryTsKey, String(Date.now()));
      } else {
        attemptTakePrimary();
      }
    }, heartbeatMs);

    window.addEventListener('storage', (e) => {
      if (e.key === primaryKey || e.key === primaryTsKey) {
        const currentId = localStorage.getItem(primaryKey);
        isPrimaryTab = currentId === tabId;
      }
    });

    document.addEventListener('visibilitychange', () => {
      attemptTakePrimary();
      if (document.visibilityState === 'visible') {
        if (!ws || ws.readyState === WebSocket.CLOSED) {
          connect();
        }
        fetchStateOnce();
        if (localStorage.getItem('audioUnlocked') === '1') {
          AudioEngine.unlock();
        }
      }
    });
  }

  function ensureAudioUnlocked() {
    // Rely on actual AudioContext state
    const ctx = AudioEngine.getContext();
    if (ctx.state === 'suspended') {
      return false;
    }
    return true;
  }

  async function unlockAudioAndReplay() {
    const state = await AudioEngine.unlock();
    if (state === 'running') {
      localStorage.setItem('audioUnlocked', '1');
      setAudioReady(true);
      if (pendingSoundEvent) {
        if (pendingSoundEvent.type === 'alarm') {
          AudioEngine.startLoop(pendingSoundEvent.preset, pendingSoundEvent.volume);
        } else {
          AudioEngine.playTone(pendingSoundEvent.preset, pendingSoundEvent.volume);
        }
        pendingSoundEvent = null;
      }
    }
  }

  function exportUsageCsv(source) {
    const end = Date.now();
    const start = end - usageRangeHours * 60 * 60 * 1000;
    const rows = state.completions.filter(c => {
      if (source && c.source !== source) return false;
      const t = new Date(c.timestamp).getTime();
      return t >= start && t <= end;
    });

    const header = ['timestamp', 'source', 'duration_ms'];
    const lines = rows.map(r => [
      r.timestamp,
      r.source,
      r.duration || ''
    ].join(','));
    const csv = [header.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const name = source ? `${source}-usage-${usageRangeHours}h.csv` : `usage-${usageRangeHours}h.csv`;
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function updateVolumeLabel() {
    const val = state.settings.notifications.alarmVolume ?? 0.3;
    const label = document.getElementById('volume-value');
    label.textContent = `${Math.round(val * 100)}%`;
    const slider = document.getElementById('volume');
    slider.style.background = `linear-gradient(90deg, var(--accent) ${val * 100}%, rgba(148,163,184,0.35) ${val * 100}%)`;
  }

  function updateSoundOptionVisibility() {
    const show = state.settings.notifications.sound || state.settings.notifications.alarm;
    document.getElementById('sound-options').style.display = show ? 'flex' : 'none';
    document.getElementById('volume-row').style.display = show ? 'flex' : 'none';
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {
    getState: () => state,
    send
  };
})();
