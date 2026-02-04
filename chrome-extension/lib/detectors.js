// lib/detectors.js - Site-specific completion detection
// Modified to support onGeneratingStart callback for hub reporting

(function() {
  'use strict';

  // Detection state
  let currentObserver = null;
  let isGenerating = false;
  let completionCallback = null;
  let generatingCallback = null;
  let debounceTimer = null;
  let pollIntervalId = null;
  let activityObserver = null;
  let activityIdleTimer = null;
  let lastActivityTs = 0;

  // Debounce delay to avoid false positives (ms)
  const DEBOUNCE_DELAY = 500;

  // ============================================
  // MAIN INITIALIZATION
  // ============================================

  function initDetector(site, onComplete, onGeneratingStart) {
    completionCallback = onComplete;
    generatingCallback = onGeneratingStart || null;

    console.log('[LLM Notify] Initializing detector for:', site);

    // Clean up any existing observer
    if (currentObserver) {
      currentObserver.disconnect();
    }
    if (pollIntervalId) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (activityObserver) {
      activityObserver.disconnect();
      activityObserver = null;
    }
    if (activityIdleTimer) {
      clearTimeout(activityIdleTimer);
      activityIdleTimer = null;
    }

    // Reset state
    isGenerating = false;

    // Initialize site-specific detector
    switch (site) {
      case 'claude':
        initClaudeDetector();
        break;
      case 'chatgpt':
        initChatGPTDetector();
        break;
      case 'gemini':
        initGeminiDetector();
        break;
      case 'grok':
        initGrokDetector();
        break;
      default:
        console.warn('[LLM Notify] No detector for site, using generic:', site);
        initGenericDetector();
    }
  }

  // ============================================
  // COMPLETION TRIGGER (with debounce)
  // ============================================

  function triggerCompletion() {
    // Clear any pending trigger
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    // Debounce to ensure generation is truly complete
    debounceTimer = setTimeout(() => {
      if (isGenerating) {
        console.log('[LLM Notify] Response complete detected');
        isGenerating = false;

        if (completionCallback) {
          completionCallback();
        }
      }
    }, DEBOUNCE_DELAY);
  }

  function markGenerating() {
    if (window.__llmNotifyRequireArm && !window.__llmNotifyArmed) {
      return;
    }
    if (!isGenerating) {
      console.log('[LLM Notify] Generation started');
      isGenerating = true;

      // Notify hub that generation started
      if (generatingCallback) {
        try {
          generatingCallback();
        } catch (e) {
          // Ignore callback errors
        }
      }
    }

    // Clear any pending completion trigger
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  // ============================================
  // GENERIC DETECTOR (for custom LLMs)
  // ============================================

  function initGenericDetector() {
    console.log('[LLM Notify] Setting up Generic detector');

    currentObserver = new MutationObserver(() => {
      checkGenericState();
    });

    currentObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true
    });

    // Fallback: detect streaming by observing text changes in main content
    const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
    startActivityObserver(main);
    setupGenericInputArming();

    pollIntervalId = setInterval(checkGenericState, 1200);
    checkGenericState();
  }

  function checkGenericState() {
    let isStreaming = false;

    // Common stop buttons
    const stopButtons = document.querySelectorAll(
      'button[aria-label*="Stop"], button[aria-label*="stop"], ' +
      'button[aria-label*="Stop generating"], button[aria-label*="stop generating"], ' +
      'button[data-testid*="stop"], button[class*="stop"]'
    );
    stopButtons.forEach(btn => {
      if (isElementVisible(btn)) isStreaming = true;
    });

    // Common streaming indicators
    if (!isStreaming) {
      const indicators = document.querySelectorAll(
        '[data-is-streaming="true"], [aria-busy="true"], ' +
        '[class*="streaming"], [class*="typing"], [class*="loading"], ' +
        '[class*="thinking"], [class*="progress"]'
      );
      indicators.forEach(el => {
        if (isElementVisible(el)) isStreaming = true;
      });
    }

    if (isStreaming) {
      markGenerating();
    } else if (isGenerating) {
      triggerCompletion();
    }
  }

  function setupGenericInputArming() {
    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) return;
      if (event.key !== 'Enter') return;
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!isChatInputTarget(event.target)) return;
      markGenerating();
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
        'button[data-testid*="send"]',
        'button[class*="send"]'
      ].join(',');
      if (target.closest(sendSelector)) {
        markGenerating();
      }
    }, true);
  }

  // ============================================
  // CLAUDE.AI DETECTOR
  // ============================================

  function initClaudeDetector() {
    console.log('[LLM Notify] Setting up Claude detector');

    // Claude's stop button indicators
    const stopButtonSelectors = [
      'button[aria-label*="Stop"]',
      'button[aria-label*="Stop generating"]',
      'button[aria-label*="stop"]',
      '[data-testid="stop-button"]',
      'button[data-testid*="stop"]',
      'button[class*="stop"]'
    ];

    // Watch for DOM changes
    currentObserver = new MutationObserver((mutations) => {
      checkClaudeState(stopButtonSelectors);
    });

    // Observe the entire document for changes
    currentObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'aria-hidden', 'data-is-streaming']
    });

    // Initial state check
    checkClaudeState(stopButtonSelectors);
  }

  function checkClaudeState(selectors) {
    // Look for any stop button
    let stopButtonVisible = false;

    for (const selector of selectors) {
      try {
        const button = document.querySelector(selector);
        if (button && isElementVisible(button)) {
          stopButtonVisible = true;
          break;
        }
      } catch (e) {
        // Invalid selector, skip
      }
    }

    // Alternative: Look for streaming indicator in message
    const streamingIndicator = document.querySelector('[data-is-streaming="true"]');
    if (streamingIndicator) {
      stopButtonVisible = true;
    }

    // Also check for the "is-streaming" class pattern Claude might use
    const streamingMessage = document.querySelector('.is-streaming, [class*="streaming"]');
    if (streamingMessage) {
      stopButtonVisible = true;
    }

    // Check for cursor blink animation that indicates streaming
    const cursorBlink = document.querySelector('[class*="cursor"][class*="blink"], .animate-pulse');
    if (cursorBlink && isElementVisible(cursorBlink)) {
      stopButtonVisible = true;
    }

    if (stopButtonVisible) {
      markGenerating();
    } else if (isGenerating) {
      // Was generating, now stopped
      triggerCompletion();
    }
  }

  // ============================================
  // CHATGPT DETECTOR
  // ============================================

  function initChatGPTDetector() {
    console.log('[LLM Notify] Setting up ChatGPT detector');

    currentObserver = new MutationObserver((mutations) => {
      checkChatGPTState();
    });

    currentObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true
    });

    // Also poll periodically as backup
    pollIntervalId = setInterval(checkChatGPTState, 1000);

    checkChatGPTState();
  }

  function checkChatGPTState() {
    let isStreaming = false;

    // Method 1: Look for stop button by aria-label
    const stopButtons = document.querySelectorAll(
      'button[aria-label*="Stop"], button[aria-label*="stop"], ' +
      'button[aria-label*="Stop generating"], button[aria-label*="stop generating"], ' +
      'button[data-testid="stop-button"]'
    );
    stopButtons.forEach(btn => {
      if (isElementVisible(btn)) {
        isStreaming = true;
      }
    });

    // Method 2: Look for any button containing "Stop" text in the main chat area
    if (!isStreaming) {
      const allButtons = document.querySelectorAll('main button, [role="main"] button, form button');
      allButtons.forEach(btn => {
        const text = (btn.textContent || '').toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        if ((text.includes('stop') || ariaLabel.includes('stop')) && isElementVisible(btn)) {
          isStreaming = true;
        }
      });
    }

    // Method 3: Look for the streaming/thinking indicator (pulsing dots, etc.)
    if (!isStreaming) {
      const thinkingIndicators = document.querySelectorAll(
        '[class*="thinking"], [class*="typing"], [class*="loading"], ' +
        '[class*="streaming"], [class*="progress"], [class*="pending"]'
      );
      thinkingIndicators.forEach(el => {
        if (isElementVisible(el) && el.closest('main, [role="main"], [class*="conversation"]')) {
          isStreaming = true;
        }
      });
    }

    // Method 4: Look for result-streaming class (older ChatGPT versions)
    if (!isStreaming) {
      const streamingResult = document.querySelector('.result-streaming, [class*="result-streaming"]');
      if (streamingResult && isElementVisible(streamingResult)) {
        isStreaming = true;
      }
    }

    // Method 5: Look for the animated cursor/caret that appears during streaming
    if (!isStreaming) {
      const cursor = document.querySelector('[class*="cursor"], [class*="caret"]');
      if (cursor && isElementVisible(cursor)) {
        const style = window.getComputedStyle(cursor);
        // Check if it has animation (indicating active streaming)
        if (style.animation && style.animation !== 'none') {
          isStreaming = true;
        }
      }
    }

    // Method 6: Check for SVG stop icon (square shape commonly used for stop)
    if (!isStreaming) {
      const stopIcons = document.querySelectorAll('button svg rect, button svg[class*="stop"], button [data-testid="stop-button"]');
      stopIcons.forEach(icon => {
        const btn = icon.closest('button');
        if (btn && isElementVisible(btn)) {
          isStreaming = true;
        }
      });
    }

    if (isStreaming) {
      markGenerating();
    } else if (isGenerating) {
      triggerCompletion();
    }
  }

  // ============================================
  // GEMINI DETECTOR
  // ============================================

  function initGeminiDetector() {
    console.log('[LLM Notify] Setting up Gemini detector');

    currentObserver = new MutationObserver((mutations) => {
      checkGeminiState();
    });

    currentObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true
    });

    // Fallback: detect streaming by observing text changes in main content
    const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
    startActivityObserver(main);

    checkGeminiState();
  }

  function checkGeminiState() {
    let isStreaming = false;

    // Gemini shows a stop button or loading indicator while generating
    const stopIndicators = document.querySelectorAll(
      '[aria-label*="Stop"], ' +
      '[aria-label*="Stop generating"], ' +
      '[aria-label*="stop"], ' +
      '[data-tooltip*="Stop"], ' +
      'button[aria-label*="Cancel"], ' +
      'button[data-testid*="stop"]'
    );

    stopIndicators.forEach(indicator => {
      if (isElementVisible(indicator)) {
        isStreaming = true;
      }
    });

    // Look for the blinking cursor that appears during generation
    const cursor = document.querySelector(
      '.blinking-cursor, ' +
      '[class*="cursor"][class*="blink"], ' +
      '.typing-indicator, ' +
      '[class*="typing"]'
    );

    if (cursor && isElementVisible(cursor)) {
      isStreaming = true;
    }

    // Check for loading/generating indicators
    const loadingIndicators = document.querySelectorAll(
      '[class*="loading"], ' +
      '[class*="generating"], ' +
      '[class*="pending"]'
    );

    loadingIndicators.forEach(indicator => {
      if (isElementVisible(indicator) &&
          (indicator.closest('[class*="response"], [class*="message"], [class*="answer"]'))) {
        isStreaming = true;
      }
    });

    if (isStreaming) {
      markGenerating();
    } else if (isGenerating) {
      triggerCompletion();
    }
  }

  // ============================================
  // GROK DETECTOR
  // ============================================

  function initGrokDetector() {
    console.log('[LLM Notify] Setting up Grok detector');

    // Handle both grok.com and x.com/i/grok
    const isXcom = window.location.hostname === 'x.com';

    if (isXcom && !window.location.pathname.startsWith('/i/grok')) {
      console.log('[LLM Notify] On x.com but not in Grok, skipping');
      return;
    }

    currentObserver = new MutationObserver((mutations) => {
      checkGrokState();
    });

    currentObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true
    });

    checkGrokState();
  }

  function checkGrokState() {
    let isStreaming = false;

    // Grok indicators for streaming
    const streamingIndicators = document.querySelectorAll(
      '[aria-label*="Stop"], ' +
      '[aria-label*="Stop generating"], ' +
      'button[aria-label*="stop"], ' +
      'button[data-testid*="stop"], ' +
      '[class*="streaming"], ' +
      '[class*="generating"], ' +
      '[class*="loading"]'
    );

    streamingIndicators.forEach(indicator => {
      if (isElementVisible(indicator)) {
        isStreaming = true;
      }
    });

    // Check for stop button specifically
    const buttons = document.querySelectorAll('button');
    buttons.forEach(btn => {
      const text = btn.textContent || '';
      const ariaLabel = btn.getAttribute('aria-label') || '';
      if ((text.toLowerCase().includes('stop') || ariaLabel.toLowerCase().includes('stop')) &&
          isElementVisible(btn)) {
        isStreaming = true;
      }
    });

    // Check for typing/cursor indicators
    const typingIndicator = document.querySelector(
      '[class*="typing"], ' +
      '[class*="cursor"][class*="blink"], ' +
      '.animate-pulse'
    );

    if (typingIndicator && isElementVisible(typingIndicator)) {
      isStreaming = true;
    }

    if (isStreaming) {
      markGenerating();
    } else if (isGenerating) {
      triggerCompletion();
    }
  }

  // ============================================
  // ACTIVITY-BASED FALLBACK (text streaming)
  // ============================================

  function startActivityObserver(root) {
    if (!root) return;

    activityObserver = new MutationObserver((mutations) => {
      if (!mutationsContainText(mutations)) return;
      lastActivityTs = Date.now();
      markGenerating();
      scheduleIdleCompletion();
    });

    activityObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function scheduleIdleCompletion() {
    if (activityIdleTimer) clearTimeout(activityIdleTimer);
    activityIdleTimer = setTimeout(() => {
      if (!isGenerating) return;
      const idleMs = Date.now() - lastActivityTs;
      if (idleMs >= 1200) {
        triggerCompletion();
      }
    }, 1200);
  }

  function mutationsContainText(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const text = mutation.target?.textContent || '';
        if (text.trim().length > 0) return true;
      }
      if (mutation.addedNodes && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            if ((node.textContent || '').trim().length > 0) return true;
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node;
            if ((el.textContent || '').trim().length > 0) return true;
          }
        }
      }
    }
    return false;
  }

  // ============================================
  // UTILITY FUNCTIONS
  // ============================================

  function isChatInputTarget(target) {
    if (!target) return false;
    if (target.closest) {
      return !!target.closest('textarea, [contenteditable="true"], [role="textbox"]');
    }
    return false;
  }

  function isElementVisible(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  // Export
  window.initDetector = initDetector;

})();
