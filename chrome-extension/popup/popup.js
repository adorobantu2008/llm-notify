// popup.js - Settings UI logic with all features

document.addEventListener('DOMContentLoaded', async () => {
  const HUB_URL = 'http://localhost:3847';
  // ============================================
  // DOM ELEMENTS
  // ============================================

  const elements = {
    enabled: document.getElementById('enabled'),
    dndToggle: document.getElementById('dnd-toggle'),
    dndStatus: document.getElementById('dnd-status'),
    desktopAlerts: document.getElementById('desktop-alerts'),
    soundEnabled: document.getElementById('sound-enabled'),
    soundPreset: document.getElementById('sound-preset'),
    soundSelectorRow: document.getElementById('sound-selector-row'),
    previewSound: document.getElementById('preview-sound'),
    alarmEnabled: document.getElementById('alarm-enabled'),
    notificationSettings: document.getElementById('notification-settings'),
    alarmBanner: document.getElementById('alarm-banner'),
    dismissAlarm: document.getElementById('dismiss-alarm'),
    shortcutModifier: document.getElementById('shortcut-modifier'),
    themeToggle: document.getElementById('theme-toggle'),
    testNotification: document.getElementById('test-notification'),
    openDashboard: document.getElementById('open-dashboard'),
    addCustom: document.getElementById('add-custom-llm'),
    customList: document.getElementById('custom-llm-list')
  };

  // ============================================
  // THEME MANAGEMENT
  // ============================================

  function initTheme() {
    const saved = localStorage.getItem('llm-notify-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    setTheme(theme);
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('llm-notify-theme', theme);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    setTheme(current === 'dark' ? 'light' : 'dark');
  }

  elements.themeToggle.addEventListener('click', toggleTheme);
  initTheme();

  // ============================================
  // PLATFORM DETECTION
  // ============================================

  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  if (elements.shortcutModifier) {
    elements.shortcutModifier.textContent = isMac ? 'Cmd' : 'Ctrl';
  }

  // ============================================
  // LOAD SETTINGS
  // ============================================

  await loadSettings();
  await checkAlarmState();
  await renderCustomList();

  // ============================================
  // STORAGE CHANGE LISTENER
  // ============================================

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync') {
      if (changes.enabled) {
        elements.enabled.checked = changes.enabled.newValue;
        updateUIState(changes.enabled.newValue);
      }

      if (changes.doNotDisturb) {
        elements.dndToggle.checked = changes.doNotDisturb.newValue;
        updateDndUI(changes.doNotDisturb.newValue);
      }

      if (changes.notifications) {
        const notif = changes.notifications.newValue;
        elements.desktopAlerts.checked = notif.desktop !== false;
        elements.soundEnabled.checked = notif.sound !== false;
        elements.soundPreset.value = notif.soundPreset || 'chime';
        elements.alarmEnabled.checked = notif.alarm === true;
        toggleSoundSelector(notif.sound !== false);
      }
    }

    if (areaName === 'local' && changes.alarmState) {
      elements.alarmBanner.style.display =
        changes.alarmState.newValue?.isActive ? 'flex' : 'none';
    }
  });

  // ============================================
  // EVENT HANDLERS
  // ============================================

  // Master toggle
  elements.enabled.addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ enabled: e.target.checked });
    updateUIState(e.target.checked);
  });

  // DND toggle
  elements.dndToggle.addEventListener('change', async (e) => {
    const isDnd = e.target.checked;
    await chrome.storage.sync.set({ doNotDisturb: isDnd });
    updateDndUI(isDnd);

    // Update badge
    if (isDnd) {
      chrome.action.setBadgeText({ text: 'Z' });
      chrome.action.setBadgeBackgroundColor({ color: '#F59E0B' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  });

  // Desktop alerts toggle
  elements.desktopAlerts.addEventListener('change', async (e) => {
    await saveNotificationSetting('desktop', e.target.checked);
  });

  // Sound toggle
  elements.soundEnabled.addEventListener('change', async (e) => {
    await saveNotificationSetting('sound', e.target.checked);
    toggleSoundSelector(e.target.checked);
  });

  // Sound preset selector
  elements.soundPreset.addEventListener('change', async (e) => {
    await saveNotificationSetting('soundPreset', e.target.value);
  });

  // Preview sound button
  elements.previewSound.addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: 'PLAY_PREVIEW',
      preset: elements.soundPreset.value
    });

    // Visual feedback
    elements.previewSound.classList.add('playing');
    setTimeout(() => {
      elements.previewSound.classList.remove('playing');
    }, 500);
  });

  // Alarm toggle
  elements.alarmEnabled.addEventListener('change', async (e) => {
    await saveNotificationSetting('alarm', e.target.checked);
  });

  // Dismiss alarm button
  elements.dismissAlarm.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'DISMISS_ALARM' });
    elements.alarmBanner.classList.add('dismissing');
    setTimeout(() => {
      elements.alarmBanner.style.display = 'none';
      elements.alarmBanner.classList.remove('dismissing');
    }, 200);
  });

  // Test notification button
  elements.testNotification.addEventListener('click', async () => {
    const btn = elements.testNotification;
    const originalHTML = btn.innerHTML;

    btn.disabled = true;
    btn.innerHTML = 'Sending...';

    await chrome.runtime.sendMessage({ type: 'TEST_NOTIFICATION' });

    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }, 1500);
  });

  // Open dashboard button
  elements.openDashboard.addEventListener('click', () => {
    chrome.tabs.create({ url: HUB_URL });
  });

  elements.addCustom.addEventListener('click', async () => {
    elements.addCustom.disabled = true;
    const originalText = elements.addCustom.textContent;
    elements.addCustom.textContent = 'Adding...';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return;
      const domain = normalizeDomain(tab.url);
      if (!domain) return;
      const known = getKnownSite(domain);
      const name = known?.name || inferName(tab.title, domain);
      const id = known?.id || slugify(domain);

      const result = await chrome.runtime.sendMessage({
        type: 'ADD_CUSTOM_SITE',
        site: { id, name, domains: [domain], enabled: true },
        tabId: tab.id
      });

      if (result?.success) {
        await renderCustomList();
      }
    } finally {
      elements.addCustom.disabled = false;
      elements.addCustom.textContent = originalText;
    }
  });

  // ============================================
  // HELPER FUNCTIONS
  // ============================================

  function getKnownSite(domain) {
    const known = {
      'claude.ai': { id: 'claude', name: 'Claude' },
      'chat.openai.com': { id: 'chatgpt', name: 'ChatGPT' },
      'chatgpt.com': { id: 'chatgpt', name: 'ChatGPT' },
      'gemini.google.com': { id: 'gemini', name: 'Gemini' },
      'aistudio.google.com': { id: 'gemini', name: 'Gemini' },
      'bard.google.com': { id: 'gemini', name: 'Gemini' },
      'grok.com': { id: 'grok', name: 'Grok' },
      'x.com': { id: 'grok', name: 'Grok' }
    };
    return known[(domain || '').toLowerCase()] || null;
  }

  async function loadSettings() {
    const data = await chrome.storage.sync.get(['enabled', 'notifications', 'doNotDisturb']);

    const enabled = data.enabled !== false;
    elements.enabled.checked = enabled;
    updateUIState(enabled);

    const isDnd = data.doNotDisturb === true;
    elements.dndToggle.checked = isDnd;
    updateDndUI(isDnd);

    const notif = data.notifications || {};
    elements.desktopAlerts.checked = notif.desktop !== false;
    elements.soundEnabled.checked = notif.sound !== false;
    elements.soundPreset.value = notif.soundPreset || 'chime';
    elements.alarmEnabled.checked = notif.alarm === true;

    toggleSoundSelector(notif.sound !== false);
  }

  async function renderCustomList() {
    try {
      await chrome.runtime.sendMessage({ type: 'SYNC_CUSTOM_SITES', force: true });
    } catch {
      // ignore sync errors
    }
    const { customSites = [] } = await chrome.storage.sync.get(['customSites']);
    elements.customList.innerHTML = customSites.length === 0
      ? '<div class="custom-llm-hint">No custom LLMs yet.</div>'
      : customSites.map(site => `
        <div class="custom-llm-item">
          <div class="custom-llm-info">
            <div class="custom-llm-name">${site.name}</div>
            <div class="custom-llm-domain">${(site.domains || []).join(', ')}</div>
          </div>
          <div class="custom-llm-actions">
            <label class="toggle">
              <input type="checkbox" data-custom-id="${site.id}" ${site.enabled !== false ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
            <button class="custom-llm-rename" data-rename-id="${site.id}">Rename</button>
            <button class="custom-llm-remove" data-remove-id="${site.id}">Remove</button>
          </div>
        </div>
      `).join('');

    elements.customList.querySelectorAll('input[data-custom-id]').forEach(input => {
      input.addEventListener('change', async (e) => {
        const id = e.target.dataset.customId;
        await chrome.runtime.sendMessage({
          type: 'TOGGLE_CUSTOM_SITE',
          id,
          enabled: e.target.checked
        });
        await renderCustomList();
      });
    });

    elements.customList.querySelectorAll('button[data-remove-id]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.dataset.removeId;
        await chrome.runtime.sendMessage({ type: 'REMOVE_CUSTOM_SITE', id });
        await renderCustomList();
      });
    });

    elements.customList.querySelectorAll('button[data-rename-id]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.dataset.renameId;
        const { customSites = [] } = await chrome.storage.sync.get(['customSites']);
        const current = customSites.find(s => s.id === id);
        const nextName = prompt('Rename LLM', current?.name || '');
        if (!nextName) return;
        const next = customSites.map(s => s.id === id ? { ...s, name: nextName } : s);
        await chrome.storage.sync.set({ customSites: next });
        try {
          await fetch(`${HUB_URL}/api/event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source: id,
              status: 'idle',
              displayName: nextName,
              timestamp: Date.now()
            })
          });
        } catch (_) {}
        await renderCustomList();
      });
    });
  }

  function normalizeDomain(input) {
    try {
      const withProtocol = input.includes('://') ? input : `https://${input}`;
      const url = new URL(withProtocol);
      return url.hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return null;
    }
  }

  function inferName(title, domain) {
    const presets = {
      'perplexity.ai': 'Perplexity',
      'chatgpt.com': 'ChatGPT',
      'chat.openai.com': 'ChatGPT',
      'claude.ai': 'Claude',
      'gemini.google.com': 'Gemini',
      'aistudio.google.com': 'Gemini',
      'grok.com': 'Grok',
      'x.com': 'Grok'
    };
    const key = Object.keys(presets).find((d) => domain === d || domain.endsWith(`.${d}`));
    if (key) return presets[key];

    if (title) {
      const knownNames = Object.values(presets);
      const hit = knownNames.find((n) => title.toLowerCase().includes(n.toLowerCase()));
      if (hit) return hit;
      const cleaned = title.split('|')[0].split('–')[0].split('-')[0].trim();
      if (cleaned.length >= 3) return cleaned;
    }
    const root = (domain || '').split('.').slice(0, -1).join('.');
    const normalized = root.replace(/[-_]+/g, ' ').trim();
    return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : 'Custom LLM';
  }

  function slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  async function saveNotificationSetting(key, value) {
    const { notifications = {} } = await chrome.storage.sync.get(['notifications']);
    notifications[key] = value;
    await chrome.storage.sync.set({ notifications });
    try {
      await fetch(`${HUB_URL}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifications })
      });
    } catch {
      // Hub might be offline; ignore
    }
  }

  function updateUIState(enabled) {
    elements.notificationSettings.classList.toggle('disabled', !enabled);
  }

  function updateDndUI(isDnd) {
    elements.dndStatus.textContent = isDnd ? 'Notifications paused' : 'All notifications active';
    document.body.setAttribute('data-dnd', isDnd);
  }

  function toggleSoundSelector(show) {
    elements.soundSelectorRow.style.display = show ? 'flex' : 'none';
  }

  async function checkAlarmState() {
    try {
      const { alarmState } = await chrome.storage.local.get(['alarmState']);
      elements.alarmBanner.style.display = alarmState?.isActive ? 'flex' : 'none';
    } catch (e) {
      // Ignore errors
    }
  }

  // Listen for alarm state changes from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'ALARM_STATE_CHANGED') {
      elements.alarmBanner.style.display = message.isActive ? 'flex' : 'none';
    }
  });
});
