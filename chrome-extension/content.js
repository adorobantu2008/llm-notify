// content.js - Injected into LLM sites
// Reports to both Chrome extension and LLM Notify Hub

(function() {
  'use strict';

  if (window.__llmNotifyLoaded) return;
  window.__llmNotifyLoaded = true;

  const HUB_URL = 'http://localhost:3847';
  const hostname = window.location.hostname;
  const pathname = window.location.pathname;

  console.log('[LLM Notify] Content script loaded:', hostname);

  // Detect site
  function detectSite(customSites) {
    if (Array.isArray(customSites)) {
      for (const site of customSites) {
        if (site?.enabled === false) continue;
        if (!site?.domains?.length) continue;
        if (site.domains.some((d) => hostMatches(d, hostname))) {
          return { id: site.id, name: site.name };
        }
      }
    }
    return null;
  }

  function hostMatches(domain, host) {
    const d = (domain || '').toLowerCase();
    const h = (host || '').toLowerCase();
    return h === d || h.endsWith(`.${d}`);
  }

  // Map site name to hub source name
  function getHubSourceName(site) {
    const mapping = {
      'claude': 'claude-ai',
      'chatgpt': 'chatgpt',
      'gemini': 'gemini',
      'grok': 'grok'
    };
    return mapping[site] || site;
  }

  let currentSite = null;
  let currentSiteName = null;

  // Require explicit user action to arm Gemini detection to reduce false positives
  window.__llmNotifyRequireArm = false;
  let armTimeoutId = null;

  function disarmDetector(reason) {
    if (!window.__llmNotifyRequireArm) return;
    window.__llmNotifyArmed = false;
    window.__llmNotifyArmedAt = null;
    if (armTimeoutId) {
      clearTimeout(armTimeoutId);
      armTimeoutId = null;
    }
    if (reason) {
      console.log('[LLM Notify] Gemini detector disarmed:', reason);
    }
  }

  function armDetector(reason) {
    if (!window.__llmNotifyRequireArm) return;
    window.__llmNotifyArmed = true;
    window.__llmNotifyArmedAt = Date.now();
    if (armTimeoutId) clearTimeout(armTimeoutId);
    armTimeoutId = setTimeout(() => {
      disarmDetector('arm timeout');
    }, 120000);
    if (reason) {
      console.log('[LLM Notify] Gemini detector armed:', reason);
    }
  }

  function isChatInputTarget(target) {
    if (!target) return false;
    if (target.closest) {
      return !!target.closest('textarea, [contenteditable="true"], [role="textbox"]');
    }
    return false;
  }

  function setupGeminiArming() {
    if (currentSite !== 'gemini') return;

    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) return;
      if (event.key !== 'Enter') return;
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!isChatInputTarget(event.target)) return;
      armDetector('enter key');
    }, true);

    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      const sendSelector = [
        'button[type="submit"]',
        'button[aria-label*="Send"]',
        'button[aria-label*="send"]',
        'button[aria-label*="Submit"]',
        'button[title*="Send"]',
        'button[data-testid*="send"]'
      ].join(',');
      if (target.closest(sendSelector)) {
        armDetector('send click');
      }
    }, true);
  }

  // Report to hub
  async function reportToHub(status, duration = null) {
    try {
      const response = await fetch(`${HUB_URL}/api/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: getHubSourceName(currentSite),
          displayName: currentSiteName,
          origin: 'extension',
          domains: hostname ? [hostname] : undefined,
          status: status,
          duration: duration,
          url: window.location.href,
          timestamp: Date.now()
        })
      });
      if (response.ok) {
        console.log('[LLM Notify] Reported to hub:', status);
      }
    } catch (err) {
      // Hub not running - silently fail
      // Extension will still work standalone
    }
  }

  // Check if enabled before initializing
  async function init() {
    try {
      // Check if extension context is valid
      if (!chrome?.storage?.sync) {
        console.warn('[LLM Notify] Extension context not available');
        return;
      }

      const settings = await chrome.storage.sync.get(['enabled', 'customSites']);

      if (settings.enabled === false) {
        console.log('[LLM Notify] Extension disabled');
        return;
      }

      const detected = detectSite(settings.customSites || []);
      if (!detected) return;
      currentSite = detected.id;
      currentSiteName = detected.name;

      console.log('[LLM Notify] Detected site:', currentSite);
      window.__llmNotifyRequireArm = currentSite === 'gemini';
      setupGeminiArming();

      // Wait for page load
      if (document.readyState === 'complete') {
        startDetector();
      } else {
        window.addEventListener('load', startDetector);
      }
    } catch (error) {
      // Silently handle extension context invalidation
      if (!error.message?.includes('Extension context invalidated')) {
        console.error('[LLM Notify] Init error:', error);
      }
    }
  }

  let generatingStartTime = null;

  function startDetector() {
    setTimeout(() => {
      if (typeof initDetector === 'function') {
        initDetector(currentSite, notifyCompletion, onGeneratingStart);
      } else {
        console.error('[LLM Notify] initDetector not found');
      }
    }, 1000);
  }

  // Called when generation starts (optional callback)
  function onGeneratingStart() {
    generatingStartTime = Date.now();
    reportToHub('generating');
  }

  async function notifyCompletion() {
    // Calculate duration if we tracked start time
    const duration = generatingStartTime ? Date.now() - generatingStartTime : null;
    generatingStartTime = null;

    disarmDetector('completion');

    // Report to hub first (non-blocking)
    reportToHub('complete', duration);

    try {
      // Check if extension context is still valid
      if (!chrome?.storage?.sync) {
        console.warn('[LLM Notify] Extension context invalidated, skipping notification');
        return;
      }

      // Double-check enabled state
      const settings = await chrome.storage.sync.get(['enabled']);
      if (settings.enabled === false) return;

      console.log('[LLM Notify] Sending completion message');
      chrome.runtime.sendMessage({
        type: 'LLM_RESPONSE_COMPLETE',
        site: currentSite,
        displayName: currentSiteName,
        url: window.location.href,
        timestamp: Date.now(),
        duration: duration
      }).then(() => {
        console.log('[LLM Notify] Completion message sent successfully');
      }).catch(err => {
        // Ignore "Extension context invalidated" errors - these are expected after reload
        if (!err.message?.includes('Extension context invalidated')) {
          console.error('[LLM Notify] Error sending completion message:', err);
        }
      });
    } catch (error) {
      // Silently handle extension context invalidation
      if (!error.message?.includes('Extension context invalidated')) {
        console.error('[LLM Notify] Error in notifyCompletion:', error);
      }
    }
  }

  // Listen for settings changes (with safety check)
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      try {
        if (areaName === 'sync' && changes.enabled) {
          if (changes.enabled.newValue === false) {
            console.log('[LLM Notify] Extension disabled, stopping detector');
          } else {
            console.log('[LLM Notify] Extension enabled, starting detector');
            startDetector();
          }
        }
      } catch (error) {
        // Silently handle errors
      }
    });
  }

  // Handle SPA navigation
  let lastUrl = window.location.href;
  new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      console.log('[LLM Notify] URL changed, reinitializing...');
      setTimeout(startDetector, 1000);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Start
  init();
})();
