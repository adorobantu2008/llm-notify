// lib/storage.js - Storage utilities

const StorageUtil = {
  // Default settings
  defaults: {
    enabled: true,
    notifications: {
      desktop: true,
      sound: true,
      soundPreset: 'chime',
      alarm: false,
      alarmVolume: 0.3
    }
  },

  // ============================================
  // SYNC STORAGE (User Preferences)
  // ============================================

  async getSettings() {
    const data = await chrome.storage.sync.get(['enabled', 'notifications']);

    // Merge with defaults to ensure all keys exist
    return {
      enabled: data.enabled ?? this.defaults.enabled,
      notifications: {
        ...this.defaults.notifications,
        ...data.notifications
      }
    };
  },

  async saveSettings(updates) {
    await chrome.storage.sync.set(updates);
    console.log('[LLM Notify Storage] Saved:', updates);
  },

  async updateNotificationSetting(key, value) {
    const settings = await this.getSettings();
    settings.notifications[key] = value;
    await this.saveSettings({ notifications: settings.notifications });
  },

  async resetToDefaults() {
    await chrome.storage.sync.clear();
    await this.saveSettings(this.defaults);
    console.log('[LLM Notify Storage] Reset to defaults');
  },

  // ============================================
  // LOCAL STORAGE (Runtime State)
  // ============================================

  async getLocalState() {
    const data = await chrome.storage.local.get([
      'alarmActive',
      'lastCompletionTime',
      'lastCompletionSite'
    ]);

    return {
      alarmActive: data.alarmActive ?? false,
      lastCompletionTime: data.lastCompletionTime ?? null,
      lastCompletionSite: data.lastCompletionSite ?? null
    };
  },

  async setAlarmActive(active) {
    await chrome.storage.local.set({ alarmActive: active });
  },

  async recordCompletion(site) {
    await chrome.storage.local.set({
      lastCompletionTime: Date.now(),
      lastCompletionSite: site
    });
  },

  async clearLocalState() {
    await chrome.storage.local.clear();
  },

  // ============================================
  // CHANGE LISTENERS
  // ============================================

  onSettingsChange(callback) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'sync') {
        const updates = {};
        for (const [key, { newValue }] of Object.entries(changes)) {
          updates[key] = newValue;
        }
        callback(updates);
      }
    });
  },

  onLocalStateChange(callback) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        const updates = {};
        for (const [key, { newValue }] of Object.entries(changes)) {
          updates[key] = newValue;
        }
        callback(updates);
      }
    });
  }
};

// Export for use in other scripts
// Works in both window context (content scripts) and service worker context (background)
if (typeof self !== 'undefined') {
  self.StorageUtil = StorageUtil;
}
if (typeof window !== 'undefined') {
  window.StorageUtil = StorageUtil;
}
