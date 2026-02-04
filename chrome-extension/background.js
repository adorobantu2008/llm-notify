// background.js - Service worker for LLM Notify

console.log('[LLM Notify Background] Service worker starting...');

// Import storage utility (service workers use importScripts)
try {
  importScripts('lib/storage.js');
  console.log('[LLM Notify Background] Storage utility loaded');
} catch (e) {
  console.error('[LLM Notify Background] Failed to load storage.js:', e);
}

console.log('[LLM Notify Background] Service worker loaded and ready');

// Backwards-compat guard in case older logic still references this flag
const EXTENSION_SOUND_DISABLED = false;

let syncCustomScriptsPromise = null;

// ============================================
// STATE (persisted in storage, not in-memory)
// ============================================

// Don't use in-memory state for service workers - they can be killed at any time
// Instead, use chrome.storage to persist state

// ============================================
// INITIALIZATION
// ============================================

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[LLM Notify] Extension installed:', details.reason);

  if (details.reason === 'install') {
    // First install - set defaults
    await StorageUtil.saveSettings(StorageUtil.defaults);
    console.log('[LLM Notify] Default settings saved');
    await syncCustomContentScripts();
  } else if (details.reason === 'update') {
    // Update - merge with new defaults (preserves user settings)
    const current = await StorageUtil.getSettings();
    console.log('[LLM Notify] Settings preserved after update:', current);
    await syncCustomContentScripts();
  }
  setInterval(syncFromHub, 5000);
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[LLM Notify] Browser started');

  // Check if there was an active alarm before restart
  const { alarmState } = await chrome.storage.local.get(['alarmState']);
  if (alarmState && alarmState.isActive) {
    console.log('[LLM Notify] Restoring alarm state after restart');
    // Restore alarm - it will be handled by chrome.alarms
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
    // Disable popup for quick dismiss
    chrome.action.setPopup({ popup: '' });
  } else {
    // Clear any stale alarm state
    await chrome.storage.local.set({ alarmState: { isActive: false } });
    chrome.action.setBadgeText({ text: '' });
    // Ensure popup is enabled
    chrome.action.setPopup({ popup: 'popup/popup.html' });
  }
  await syncCustomContentScripts();
  setInterval(syncFromHub, 5000);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.customSites) {
    syncCustomContentScripts();
  }
});

// ============================================
// MESSAGE HANDLING
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages meant for offscreen document - don't handle here
  const offscreenMessages = ['PLAY_SOUND', 'STOP_SOUND', 'UPDATE_VOLUME', 'PING'];
  if (offscreenMessages.includes(message?.type)) {
    // Let offscreen handle these - return false means we won't call sendResponse
    return false;
  }

  console.log('[LLM Notify Background] Message received:', message?.type);

  // Handle all other messages async
  handleMessage(message, sender, sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(message, sender, sendResponse) {
  try {
    console.log('[LLM Notify Background] Handling:', message.type);

    switch (message.type) {
      case 'LLM_RESPONSE_COMPLETE':
        console.log('[LLM Notify Background] Completion from:', message.site);
        await handleCompletion(sender.tab, message);
        sendResponse({ success: true });
        break;

      case 'DISMISS_ALARM':
        await dismissAlarm();
        sendResponse({ success: true });
        break;

      case 'PLAY_PREVIEW':
        await playPreviewSound(message.preset);
        sendResponse({ success: true });
        break;

      case 'GET_ALARM_STATE':
        const { alarmState } = await chrome.storage.local.get(['alarmState']);
        sendResponse({ isActive: alarmState?.isActive || false });
        break;

      case 'GET_SETTINGS':
        const settings = await StorageUtil.getSettings();
        sendResponse(settings);
        break;

      case 'TEST_NOTIFICATION':
        await sendTestNotification();
        sendResponse({ success: true });
        break;
      case 'ADD_CUSTOM_SITE':
        await addCustomSite(message.site, sendResponse, message.tabId);
        break;
      case 'REMOVE_CUSTOM_SITE':
        await removeCustomSite(message.id, sendResponse);
        break;
      case 'SYNC_CUSTOM_SITES':
        await syncCustomSitesFromHub(!!message.force);
        sendResponse({ success: true });
        break;
      case 'TOGGLE_CUSTOM_SITE':
        await toggleCustomSite(message.id, message.enabled, sendResponse);
        break;

      case 'ALARM_STATE_CHANGED':
        sendResponse({ success: true });
        break;

      default:
        console.warn('[LLM Notify Background] Unknown type:', message.type);
        sendResponse({ success: false });
    }
  } catch (error) {
    console.error('[LLM Notify Background] Handler error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// ============================================
// COMPLETION HANDLING
// ============================================

async function handleCompletion(_tab, message) {
  console.log('[LLM Notify] ======= HANDLING COMPLETION =======');
  console.log('[LLM Notify] Site:', message.site);

  const data = await chrome.storage.sync.get(['enabled', 'doNotDisturb', 'notifications', 'siteSettings']);
  console.log('[LLM Notify] Settings loaded:', JSON.stringify(data));

  // Check master enable and DND
  if (data.enabled === false) {
    console.log('[LLM Notify] Skipping - extension disabled');
    return;
  }
  if (data.doNotDisturb) {
    console.log('[LLM Notify] Skipping - Do Not Disturb is on');
    return;
  }

  // Record completion for potential future features
  await StorageUtil.recordCompletion(message.site);

  // Get site-specific settings
  const siteSettings = data.siteSettings || {};
  const siteConfig = siteSettings[message.site] || { enabled: true, mode: 'global' };

  // Check if site is enabled
  if (!siteConfig.enabled || siteConfig.mode === 'off') {
    console.log('[LLM Notify] Site disabled:', message.site);
    return;
  }

  // Determine which settings to use
  let prefs;
  if (siteConfig.mode === 'custom') {
    prefs = {
      desktop: siteConfig.desktop !== false,
      sound: siteConfig.sound !== false,
      soundPreset: siteConfig.soundPreset || 'chime',
      alarm: siteConfig.alarm === true,
      alarmVolume: 0.3
    };
  } else {
    // Use global settings
    prefs = data.notifications || {
      desktop: true,
      sound: true,
      soundPreset: 'chime',
      alarm: false,
      alarmVolume: 0.3
    };
  }

  console.log('[LLM Notify] Using prefs:', prefs);

  const hubStatus = await getHubStatus();
  const hubAvailable = hubStatus.available;
  const hubHasDashboards = hubStatus.dashboards > 0;
  const hubDesktopEnabled = hubStatus.desktopEnabled !== false;
  const hubAudioReady = hubStatus.audioReady;
  const useHubSound = hubAvailable && (typeof hubAudioReady === 'number' ? hubAudioReady > 0 : hubHasDashboards);
  if (!hubAvailable) {
    console.log('[LLM Notify] Hub not available - skipping notifications');
    return;
  }

  // Ensure soundPreset and volumes are defined
  if (!prefs.soundPreset) prefs.soundPreset = 'chime';
  if (!prefs.alarmVolume) prefs.alarmVolume = 0.3;

  // Show notification
  if (prefs.desktop) {
    const siteNames = {
      'claude': 'Claude',
      'chatgpt': 'ChatGPT',
      'gemini': 'Gemini',
      'grok': 'Grok'
    };

    showNotification(
      'Response Complete',
      `${message.displayName || siteNames[message.site] || message.site || 'AI'} has finished responding`
    );
  }

  if (useHubSound) {
    // Hub is running with at least one dashboard connected
    console.log('[LLM Notify] Hub is available with dashboard - dashboard will handle audio');
    if (prefs.alarm) {
      await startSilentAlarm();
    }
  } else {
    // Hub is offline or has no dashboards - play sound locally in extension
    console.log('[LLM Notify] Hub is offline or has no dashboard - playing sound locally');
    await clearSilentAlarmIfAny();
    if (prefs.alarm) {
      console.log('[LLM Notify] Starting ALARM with preset:', prefs.soundPreset);
      await startAlarm(prefs.soundPreset, prefs.alarmVolume);
    } else if (prefs.sound) {
      console.log('[LLM Notify] Playing SOUND with preset:', prefs.soundPreset);
      await playSound(prefs.soundPreset, 0.5);
    } else {
      console.log('[LLM Notify] Sound is disabled, not playing');
    }
  }
  console.log('[LLM Notify] ======= COMPLETION HANDLED =======');
}

// ============================================
// CUSTOM LLMs
// ============================================

const HUB_URL = 'http://localhost:3847';

// Check if hub is running and available
async function isHubAvailable() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000); // 1 second timeout
    const res = await fetch(`${HUB_URL}/api/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function getHubStatus() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`${HUB_URL}/api/state`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      return { available: false, dashboards: 0, desktopEnabled: true, audioReady: null };
    }
    const data = await res.json();
    const dashboards = typeof data?.clients?.dashboards === 'number' ? data.clients.dashboards : 0;
    const desktopEnabled = data?.settings?.notifications?.desktop !== false;
    const audioReady = typeof data?.clients?.audioReady === 'number' ? data.clients.audioReady : null;
    return { available: true, dashboards, desktopEnabled, audioReady };
  } catch (e) {
    return { available: false, dashboards: 0, desktopEnabled: true, audioReady: null };
  }
}

async function reportHubIdle(site) {
  try {
    await fetch(`${HUB_URL}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: site.id,
        status: 'idle',
        displayName: site.name,
        origin: 'extension',
        domains: site.domains,
        timestamp: Date.now()
      })
    });
  } catch (e) {
    console.warn('[LLM Notify] Hub notify failed:', e?.message);
  }
}

async function syncCustomSitesFromHub(force = false) {
  try {
    const healthRes = await fetch(`${HUB_URL}/api/health`);
    if (!healthRes.ok) return;
    const health = await healthRes.json();
    const uptime = typeof health?.uptime === 'number' ? health.uptime : null;
    if (uptime !== null) {
      const { hubUptime = null } = await chrome.storage.local.get(['hubUptime']);
      if (typeof hubUptime === 'number' && uptime + 1 < hubUptime) {
        await chrome.storage.sync.set({ customSites: [] });
        await syncCustomContentScripts();
      }
      await chrome.storage.local.set({ hubUptime: uptime });
    } else if (!force) {
      return;
    }

    const res = await fetch(`${HUB_URL}/api/settings`);
    if (!res.ok) return;
    const settings = await res.json();
    const sources = settings?.sources || {};
    const { customSites = [] } = await chrome.storage.sync.get(['customSites']);
    if (!customSites.length) return;

    const hasExtensionSources = Object.values(sources).some(s => s?.origin === 'extension');
    if (!hasExtensionSources) {
      await chrome.storage.sync.set({ customSites: [] });
      await syncCustomContentScripts();
      return;
    }

    const normalizeDomain = (domain) => (domain || '').toLowerCase().replace(/^www\./, '').trim();
    const knownDomainMap = {
      'chat.openai.com': { id: 'chatgpt', name: 'ChatGPT' },
      'chatgpt.com': { id: 'chatgpt', name: 'ChatGPT' },
      'grok.com': { id: 'grok', name: 'Grok' },
      'x.com': { id: 'grok', name: 'Grok' },
      'gemini.google.com': { id: 'gemini', name: 'Gemini' },
      'aistudio.google.com': { id: 'gemini', name: 'Gemini' },
      'bard.google.com': { id: 'gemini', name: 'Gemini' },
      'claude.ai': { id: 'claude', name: 'Claude' }
    };

    const normalized = [];
    const seenIds = new Set();
    for (const site of customSites) {
      const domains = (site.domains || []).map(normalizeDomain).filter(Boolean);
      const known = domains.map(d => knownDomainMap[d]).find(Boolean) || null;
      const nextId = known?.id || site.id;
      const nextName = known?.name || site.name;
      if (seenIds.has(nextId)) continue;
      seenIds.add(nextId);
      normalized.push({ ...site, id: nextId, name: nextName, domains });
    }

    if (normalized.length !== customSites.length) {
      await chrome.storage.sync.set({ customSites: normalized });
      await syncCustomContentScripts();
      return;
    }

    const toRemove = customSites.filter(site => {
      const meta = sources[site.id];
      if (!meta) return false;
      if (meta.origin !== 'extension') return false;
      return meta.hidden === true;
    });
    if (!toRemove.length) return;

    const next = customSites.filter(site => !toRemove.some(r => r.id === site.id));
    await chrome.storage.sync.set({ customSites: next });
    await syncCustomContentScripts();
  } catch {
    // ignore hub sync errors
  }
}

async function syncSettingsFromHub() {
  try {
    const res = await fetch(`${HUB_URL}/api/settings`);
    if (!res.ok) return;
    const settings = await res.json();
    const hubNotifications = settings?.notifications;
    if (!hubNotifications || typeof hubNotifications !== 'object') return;

    const { notifications = {} } = await chrome.storage.sync.get(['notifications']);
    const normalizedCurrent = normalizeNotifications(notifications);
    const normalizedHub = normalizeNotifications(hubNotifications);

    if (!areNotificationsEqual(normalizedCurrent, normalizedHub)) {
      await chrome.storage.sync.set({ notifications: normalizedHub });
    }
  } catch {
    // ignore hub sync errors
  }
}

function normalizeNotifications(input) {
  return {
    desktop: input?.desktop !== false,
    sound: input?.sound !== false,
    soundPreset: input?.soundPreset || 'chime',
    alarm: input?.alarm === true,
    alarmVolume: typeof input?.alarmVolume === 'number' ? input.alarmVolume : 0.3
  };
}

function areNotificationsEqual(a, b) {
  return a.desktop === b.desktop &&
    a.sound === b.sound &&
    a.soundPreset === b.soundPreset &&
    a.alarm === b.alarm &&
    Math.abs((a.alarmVolume ?? 0.3) - (b.alarmVolume ?? 0.3)) < 0.001;
}

async function syncFromHub() {
  await syncSettingsFromHub();
  await syncCustomSitesFromHub();
}

async function addCustomSite(site, sendResponse, tabId) {
  try {
    if (!site?.id || !site?.name || !site?.domains?.length) {
      sendResponse({ success: false, error: 'Invalid site data' });
      return;
    }

    const normalizedDomains = [...new Set(site.domains.map(d => d.toLowerCase().trim()).filter(Boolean))];
    if (!normalizedDomains.length) {
      sendResponse({ success: false, error: 'Invalid domain' });
      return;
    }

    const { customSites = [] } = await chrome.storage.sync.get(['customSites']);
    const withoutDupes = customSites.filter(s => s.id !== site.id);
    const withoutDomainDupes = withoutDupes.filter(s => {
      const domains = (s.domains || []).map(d => d.toLowerCase());
      return !normalizedDomains.some(d => domains.includes(d));
    });
    await chrome.storage.sync.set({
      customSites: [...withoutDomainDupes, { ...site, domains: normalizedDomains }]
    });
    await syncCustomContentScripts();
    await reportHubIdle(site);
    if (tabId && Number.isInteger(tabId)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['lib/storage.js', 'lib/detectors.js', 'content.js']
        });
      } catch (e) {
        console.warn('[LLM Notify] Inject failed:', e?.message);
      }
    }
    sendResponse({ success: true });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

async function removeCustomSite(id, sendResponse) {
  const { customSites = [] } = await chrome.storage.sync.get(['customSites']);
  const next = customSites.filter(s => s.id !== id);
  await chrome.storage.sync.set({ customSites: next });
  await syncCustomContentScripts();
  sendResponse({ success: true });
}

async function toggleCustomSite(id, enabled, sendResponse) {
  const { customSites = [] } = await chrome.storage.sync.get(['customSites']);
  const next = customSites.map(s => s.id === id ? { ...s, enabled } : s);
  await chrome.storage.sync.set({ customSites: next });
  await syncCustomContentScripts();
  sendResponse({ success: true });
}

async function syncCustomContentScripts() {
  if (syncCustomScriptsPromise) {
    return syncCustomScriptsPromise;
  }
  syncCustomScriptsPromise = (async () => {
  try {
    const { customSites = [] } = await chrome.storage.sync.get(['customSites']);
    const activeSites = customSites.filter(s => s.enabled !== false);

    const registered = await chrome.scripting.getRegisteredContentScripts();
    const customIds = registered
      .filter(r => r.id && r.id.startsWith('llm-notify-custom-'))
      .map(r => r.id);

    // Clean slate to avoid duplicate ID errors from Chrome registry state.
    if (customIds.length) {
      await chrome.scripting.unregisterContentScripts({ ids: customIds });
    }

    for (const site of activeSites) {
      const id = `llm-notify-custom-${site.id}`;
      const matches = site.domains.flatMap(d => buildMatchPatterns(d));
      if (!matches.length) continue;

      try {
        await chrome.scripting.registerContentScripts([{
          id,
          js: ['lib/storage.js', 'lib/detectors.js', 'content.js'],
          matches,
          runAt: 'document_idle',
          allFrames: true
        }]);
      } catch (e) {
        console.warn('[LLM Notify] registerContentScripts failed:', e?.message);
      }
    }
  } catch (e) {
    console.warn('[LLM Notify] syncCustomContentScripts failed:', e?.message);
  }
  })().finally(() => {
    syncCustomScriptsPromise = null;
  });

  return syncCustomScriptsPromise;
}

function buildMatchPatterns(domain) {
  const d = (domain || '').replace(/^www\./, '');
  if (!d) return [];
  return [
    `https://${d}/*`,
    `https://*.${d}/*`,
    `http://${d}/*`,
    `http://*.${d}/*`
  ];
}

// ============================================
// ALARM MANAGEMENT
// ============================================

async function startAlarm(preset, startVolume) {
  // Check if alarm is already active
  const { alarmState } = await chrome.storage.local.get(['alarmState']);
  if (alarmState?.isActive) {
    console.log('[LLM Notify] Alarm already active');
    return;
  }

  // Validate preset
  const validPresets = ['chime', 'bell', 'beep', 'ping', 'soft-alert', 'digital', 'gentle-bell', 'notification', 'alert-urgent', 'calm-tone', 'double-beep', 'ascending', 'custom'];
  if (!preset || typeof preset !== 'string' || !validPresets.includes(preset)) {
    console.warn('[LLM Notify] Invalid preset, defaulting to chime:', preset);
    preset = 'chime';
  }

  // Validate volume
  if (typeof startVolume !== 'number' || isNaN(startVolume) || !isFinite(startVolume)) {
    console.warn('[LLM Notify] Invalid startVolume, using 0.3:', startVolume);
    startVolume = 0.3;
  }
  startVolume = Math.max(0, Math.min(1, startVolume));

  console.log('[LLM Notify] Starting alarm with preset:', preset, 'volume:', startVolume);

  // Store alarm state in chrome.storage (survives service worker restarts)
  await chrome.storage.local.set({
    alarmState: {
      isActive: true,
      preset: preset,
      volume: startVolume,
      startTime: Date.now()
    }
  });

  // Update badge
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });

  // Disable popup so clicking icon triggers onClicked (for quick dismiss)
  chrome.action.setPopup({ popup: '' });

  // Ensure offscreen document exists
  const ready = await ensureOffscreenDocument();
  if (!ready) {
    console.error('[LLM Notify] Could not create offscreen document for alarm');
    return;
  }

  // Send PLAY_SOUND with loop=true
  console.log('[LLM Notify] Sending alarm sound message:', preset);
  try {
    await chrome.runtime.sendMessage({
      type: 'PLAY_SOUND',
      preset: preset,
      volume: startVolume,
      loop: true
    });
    console.log('[LLM Notify] Alarm started');
  } catch (err) {
    console.error('[LLM Notify] Error starting alarm:', err.message);
    // Try once more
    await new Promise(resolve => setTimeout(resolve, 200));
    try {
      await chrome.runtime.sendMessage({
        type: 'PLAY_SOUND',
        preset: preset,
        volume: startVolume,
        loop: true
      });
    } catch (retryErr) {
      console.error('[LLM Notify] Retry failed:', retryErr.message);
    }
  }

  // Create chrome.alarms for volume escalation (survives service worker restarts)
  chrome.alarms.create('escalate-alarm', {
    delayInMinutes: 8 / 60, // 8 seconds in minutes
    periodInMinutes: 8 / 60  // Repeat every 8 seconds
  });

  // Notify popup of state change
  broadcastAlarmState(true);
}

async function startSilentAlarm() {
  const { alarmState } = await chrome.storage.local.get(['alarmState']);
  if (alarmState?.isActive) return;

  await chrome.storage.local.set({
    alarmState: {
      isActive: true,
      silent: true,
      preset: 'silent',
      volume: 0,
      startTime: Date.now()
    }
  });

  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
  chrome.action.setPopup({ popup: '' });
  broadcastAlarmState(true);
}

async function clearSilentAlarmIfAny() {
  const { alarmState } = await chrome.storage.local.get(['alarmState']);
  if (!alarmState?.isActive || !alarmState?.silent) return;

  await chrome.storage.local.set({
    alarmState: { isActive: false }
  });

  chrome.action.setBadgeText({ text: '' });
  chrome.action.setPopup({ popup: 'popup/popup.html' });
  broadcastAlarmState(false);
}

async function dismissAlarm() {
  // Check if alarm is active
  const { alarmState } = await chrome.storage.local.get(['alarmState']);
  if (!alarmState?.isActive) {
    console.log('[LLM Notify] No active alarm to dismiss');
    return;
  }

  console.log('[LLM Notify] Dismissing alarm');

  // Clear chrome.alarms
  await chrome.alarms.clear('escalate-alarm');

  // Ensure offscreen document exists before stopping
  const ready = await ensureOffscreenDocument();

  // Stop sound (only if offscreen is ready)
  if (ready) {
    try {
      await chrome.runtime.sendMessage({
        type: 'STOP_SOUND'
      });
      console.log('[LLM Notify] Sound stopped');
    } catch (err) {
      // Ignore connection errors when stopping - document might already be gone
      if (!err.message?.includes('Could not establish connection')) {
        console.error('[LLM Notify] Error stopping alarm:', err.message);
      }
    }
  }

  // Clear state
  await chrome.storage.local.set({
    alarmState: {
      isActive: false
    }
  });

  // Clear badge
  chrome.action.setBadgeText({ text: '' });

  // Restore popup (so clicking icon opens settings again)
  chrome.action.setPopup({ popup: 'popup/popup.html' });

  // Notify popup
  broadcastAlarmState(false);

  try {
    await fetch(`${HUB_URL}/api/dismiss`, { method: 'POST' });
  } catch {
    // ignore hub dismiss failures
  }
}

// Handle alarm escalation
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'escalate-alarm') {
    const { alarmState } = await chrome.storage.local.get(['alarmState']);

    if (!alarmState || !alarmState.isActive) {
      // Alarm was dismissed, clear the chrome.alarms
      await chrome.alarms.clear('escalate-alarm');
      return;
    }

    // Validate current volume, default to 0.3 if invalid
    let currentVolume = alarmState.volume;
    if (typeof currentVolume !== 'number' || isNaN(currentVolume) || !isFinite(currentVolume)) {
      currentVolume = 0.3;
    }

    // Validate preset, default to 'chime' if invalid
    let preset = alarmState.preset;
    if (!preset || typeof preset !== 'string') {
      preset = 'chime';
    }

    // Increase volume
    const newVolume = Math.min(currentVolume + 0.1, 1.0);
    console.log('[LLM Notify] Escalating volume to:', newVolume);

    // Update stored volume and ensure preset is valid
    await chrome.storage.local.set({
      alarmState: {
        ...alarmState,
        preset: preset,
        volume: newVolume
      }
    });

    // Ensure offscreen document exists
    const ready = await ensureOffscreenDocument();
    if (!ready) {
      console.error('[LLM Notify] Could not create offscreen document for escalation');
      return;
    }

    // Restart the loop with new volume (use validated preset)
    try {
      await chrome.runtime.sendMessage({
        type: 'PLAY_SOUND',
        preset: preset,
        volume: newVolume,
        loop: true
      });
      console.log('[LLM Notify] Volume escalated successfully');
    } catch (err) {
      // Only log non-connection errors
      if (!err.message?.includes('Could not establish connection')) {
        console.error('[LLM Notify] Error escalating alarm:', err.message);
      }
      // Try once more after delay
      await new Promise(resolve => setTimeout(resolve, 200));
      try {
        await chrome.runtime.sendMessage({
          type: 'PLAY_SOUND',
          preset: preset,
          volume: newVolume,
          loop: true
        });
      } catch (retryErr) {
        // Silent fail on retry
      }
    }
  }
});

function broadcastAlarmState(active) {
  // Send to popup if open
  chrome.runtime.sendMessage({
    type: 'ALARM_STATE_CHANGED',
    isActive: active
  }).catch(() => {
    // Popup not open, ignore
  });
}

// ============================================
// NOTIFICATION
// ============================================

function showNotification(title, message) {
  const notificationId = `llm-notify-${Date.now()}`;

  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: title,
    message: message,
    priority: 2,
    requireInteraction: true // Keep notification visible until user interacts
  }, (id) => {
    if (chrome.runtime.lastError) {
      console.error('[LLM Notify] Notification error:', chrome.runtime.lastError.message);
    } else {
      console.log('[LLM Notify] Notification created:', id);
    }
  });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId.startsWith('llm-notify-')) {
    await dismissAlarm();
    chrome.notifications.clear(notificationId);
  }
});

// ============================================
// TEST NOTIFICATION
// ============================================

async function sendTestNotification() {
  console.log('[LLM Notify] Sending test notification...');

  const hubStatus = await getHubStatus();
  if (!hubStatus.available) {
    showNotification('LLM Notify Hub Required', 'Start the LLM Notify Hub app to enable notifications.');
    return;
  }

  const settings = await chrome.storage.sync.get(['notifications']);
  const prefs = settings.notifications || {
    desktop: true,
    sound: true,
    soundPreset: 'chime',
    alarm: false
  };

  console.log('[LLM Notify] Test notification prefs:', prefs);

  // ALWAYS show desktop notification for test (regardless of settings)
  // This helps user verify notifications are working
  const notificationId = `llm-notify-test-${Date.now()}`;

  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: 'Test Notification',
    message: 'LLM Notify is working correctly!',
    priority: 2,
    requireInteraction: false
  }, (id) => {
    if (chrome.runtime.lastError) {
      console.error('[LLM Notify] Notification error:', chrome.runtime.lastError);
    } else {
      console.log('[LLM Notify] Test notification created:', id);
    }
  });

  // Play sound based on settings
  if (prefs.alarm) {
    await startAlarm(prefs.soundPreset, prefs.alarmVolume || 0.3);
  } else if (prefs.sound) {
    await playSound(prefs.soundPreset, 0.5);
  }
}

// ============================================
// SOUND PLAYBACK
// ============================================

async function playSound(preset, volume) {
  console.log('[LLM Notify Background] playSound called with preset:', preset, 'volume:', volume);

  // Validate preset - ensure it's a string and valid
  const validPresets = ['chime', 'bell', 'beep', 'ping', 'soft-alert', 'digital', 'gentle-bell', 'notification', 'alert-urgent', 'calm-tone', 'double-beep', 'ascending', 'custom'];
  if (!preset || typeof preset !== 'string' || !validPresets.includes(preset)) {
    console.warn('[LLM Notify] Invalid preset, defaulting to chime:', preset);
    preset = 'chime';
  }

  // Validate volume - ensure it's a valid number between 0.01 and 1 (must be > 0 for Web Audio)
  if (typeof volume !== 'number' || isNaN(volume) || !isFinite(volume)) {
    console.warn('[LLM Notify] Invalid volume, defaulting to 0.5:', volume);
    volume = 0.5;
  }
  volume = Math.max(0.01, Math.min(1, volume));

  // Ensure offscreen document exists
  const ready = await ensureOffscreenDocument();
  if (!ready) {
    console.error('[LLM Notify Background] Could not create offscreen document');
    return;
  }

  // Wait for offscreen to be ready
  await new Promise(resolve => setTimeout(resolve, 100));

  // Verify offscreen is responding
  try {
    const pingResponse = await chrome.runtime.sendMessage({ type: 'PING' });
    if (!pingResponse?.pong) {
      console.warn('[LLM Notify Background] Offscreen PING failed, recreating...');
      offscreenReady = false;
      await ensureOffscreenDocument();
      await new Promise(resolve => setTimeout(resolve, 200));
    } else {
      console.log('[LLM Notify Background] Offscreen PING successful');
    }
  } catch (pingErr) {
    console.warn('[LLM Notify Background] Offscreen PING error:', pingErr.message);
    // Try to recreate offscreen document
    offscreenReady = false;
    try {
      await chrome.offscreen.closeDocument();
    } catch (e) {
      // Ignore close errors
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    const recreated = await ensureOffscreenDocument();
    if (!recreated) {
      console.error('[LLM Notify Background] Failed to recreate offscreen document');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  // Send play sound message
  console.log('[LLM Notify Background] Sending PLAY_SOUND message:', preset, 'volume:', volume);
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'PLAY_SOUND',
      preset: preset,
      volume: volume,
      loop: false
    });
    console.log('[LLM Notify Background] Sound message response:', response);
    if (response?.success) {
      console.log('[LLM Notify Background] Sound playback confirmed');
    }
  } catch (err) {
    console.error('[LLM Notify Background] Error sending sound message:', err.message);
    // One retry after delay
    await new Promise(resolve => setTimeout(resolve, 300));
    try {
      console.log('[LLM Notify Background] Retrying PLAY_SOUND...');
      await chrome.runtime.sendMessage({
        type: 'PLAY_SOUND',
        preset: preset,
        volume: volume,
        loop: false
      });
      console.log('[LLM Notify Background] Retry successful');
    } catch (retryErr) {
      console.error('[LLM Notify Background] Retry also failed:', retryErr.message);
    }
  }
}

async function playPreviewSound(preset) {
  await playSound(preset, 0.8); // Louder preview
}

// ============================================
// OFFSCREEN DOCUMENT
// ============================================

let creatingOffscreen = false;
let offscreenReady = false;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');

  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });

    if (existingContexts.length > 0) {
      offscreenReady = true;
      return true;
    }
  } catch (error) {
    console.warn('[LLM Notify] Error checking offscreen contexts:', error);
  }

  if (creatingOffscreen) {
    console.log('[LLM Notify] Already creating offscreen document, waiting...');
    // Wait for creation to complete
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (offscreenReady) return true;
    }
    return false;
  }

  console.log('[LLM Notify] Creating offscreen document...');
  creatingOffscreen = true;
  offscreenReady = false;

  try {
    await chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Playing notification sounds'
    });
    console.log('[LLM Notify] Offscreen document created successfully');
    // Give it extra time to initialize
    await new Promise(resolve => setTimeout(resolve, 300));
    offscreenReady = true;
    return true;
  } catch (error) {
    // Check if document already exists (race condition)
    if (error.message?.includes('single offscreen document')) {
      offscreenReady = true;
      return true;
    }
    console.error('[LLM Notify] Error creating offscreen document:', error);
    return false;
  } finally {
    creatingOffscreen = false;
  }
}

// ============================================
// KEYBOARD SHORTCUT
// ============================================

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'dismiss-alarm') {
    await dismissAlarm();
  }
});

// ============================================
// EXTENSION ICON CLICK - QUICK DISMISS
// ============================================

// When alarm is active, clicking the extension icon dismisses it immediately
chrome.action.onClicked.addListener(async () => {
  console.log('[LLM Notify] Icon clicked');
  try {
    const { alarmState } = await chrome.storage.local.get(['alarmState']);
    console.log('[LLM Notify] Alarm state:', alarmState);
    if (alarmState?.isActive) {
      console.log('[LLM Notify] Dismissing alarm via icon click');
      await dismissAlarm();
    }
  } catch (err) {
    console.error('[LLM Notify] Error in icon click handler:', err);
  }
  // If no alarm active, the popup will open normally (handled by manifest)
});
