// offscreen.js - Handles audio playback in offscreen document
// Complete rewrite with Web Audio API and 12 sound presets

console.log('[LLM Notify Offscreen] Document loading...');

let currentAudio = null;
let isLooping = false;
let loopInterval = null;

// Sound configurations for all 12 presets
const soundConfigs = {
  // Gentle presets
  'chime': { freq: 880, duration: 0.6, type: 'sine', harmonics: true },
  'gentle-bell': { freq: 523, duration: 0.7, type: 'sine', harmonics: true },     // C5
  'calm-tone': { freq: 440, duration: 0.8, type: 'sine', harmonics: true },       // A4
  'ping': { freq: 1200, duration: 0.25, type: 'sine', harmonics: false },

  // Standard presets
  'bell': { freq: 660, duration: 0.8, type: 'sine', harmonics: true },
  'notification': { freq: 784, duration: 0.4, type: 'triangle', harmonics: true }, // G5
  'soft-alert': { freq: 587, duration: 0.5, type: 'sine', harmonics: true },      // D5

  // Attention-grabbing presets
  'beep': { freq: 1000, duration: 0.3, type: 'square', harmonics: false },
  'digital': { freq: 1400, duration: 0.2, type: 'square', harmonics: false },
  'double-beep': { freq: 800, duration: 0.15, type: 'square', harmonics: false, double: true },
  'ascending': { freq: 600, duration: 0.4, type: 'sine', ascending: true },
  'alert-urgent': { freq: 1000, duration: 0.15, type: 'sawtooth', harmonics: false }
};

// Audio context for generating tones
let audioContext = null;

function getAudioContext() {
  if (!audioContext) {
    console.log('[LLM Notify Offscreen] Creating new AudioContext');
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  console.log('[LLM Notify Offscreen] AudioContext state:', audioContext.state);

  // Resume context if suspended (browser autoplay policy)
  if (audioContext.state === 'suspended') {
    console.log('[LLM Notify Offscreen] Resuming suspended AudioContext');
    audioContext.resume().then(() => {
      console.log('[LLM Notify Offscreen] AudioContext resumed, state:', audioContext.state);
    }).catch(err => {
      console.error('[LLM Notify Offscreen] Error resuming AudioContext:', err);
    });
  }

  return audioContext;
}

// Generate a tone programmatically
function playGeneratedTone(config, volume, callback) {
  console.log('[LLM Notify Offscreen] playGeneratedTone called:', config?.freq, 'Hz, volume:', volume);

  // Validate volume - exponentialRampToValueAtTime requires value > 0
  if (typeof volume !== 'number' || isNaN(volume) || !isFinite(volume)) {
    console.warn('[LLM Notify Offscreen] Invalid volume, using 0.5:', volume);
    volume = 0.5;
  }
  volume = Math.max(0.01, Math.min(1, volume)); // Clamp between 0.01 and 1 (must be > 0 for exponentialRamp)

  // Validate config
  if (!config || !config.freq || !config.duration) {
    console.error('[LLM Notify Offscreen] Invalid config:', config);
    if (callback) callback();
    return;
  }

  // Validate freq and duration are finite positive numbers
  if (!isFinite(config.freq) || config.freq <= 0 || !isFinite(config.duration) || config.duration <= 0) {
    console.error('[LLM Notify Offscreen] Invalid freq or duration:', config.freq, config.duration);
    if (callback) callback();
    return;
  }

  try {
    const ctx = getAudioContext();
    console.log('[LLM Notify Offscreen] AudioContext state:', ctx.state);

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = config.type || 'sine';
    oscillator.frequency.value = config.freq;

    console.log('[LLM Notify Offscreen] Created oscillator:', config.type, 'at', config.freq, 'Hz');

    // Set volume with envelope - ensure endValue > 0 for exponentialRamp
    const endValue = Math.max(0.001, 0.01);
    gainNode.gain.setValueAtTime(volume, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(endValue, ctx.currentTime + config.duration);

    // Handle ascending tone
    if (config.ascending) {
      oscillator.frequency.setValueAtTime(config.freq, ctx.currentTime);
      oscillator.frequency.linearRampToValueAtTime(config.freq * 1.5, ctx.currentTime + config.duration);
    }

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + config.duration);
    console.log('[LLM Notify Offscreen] Oscillator started, will stop in', config.duration, 'seconds');

    // Add harmonics for richer sound
    if (config.harmonics) {
      const harmonic = ctx.createOscillator();
      const harmonicGain = ctx.createGain();
      harmonic.connect(harmonicGain);
      harmonicGain.connect(ctx.destination);
      harmonic.type = 'sine';
      harmonic.frequency.value = config.freq * 2; // Octave up
      const harmonicVolume = Math.max(0.01, volume * 0.3);
      harmonicGain.gain.setValueAtTime(harmonicVolume, ctx.currentTime);
      harmonicGain.gain.exponentialRampToValueAtTime(endValue, ctx.currentTime + config.duration * 0.8);
      harmonic.start(ctx.currentTime);
      harmonic.stop(ctx.currentTime + config.duration * 0.8);
    }

    // Handle double beep
    if (config.double) {
      setTimeout(() => {
        try {
          const osc2 = ctx.createOscillator();
          const gain2 = ctx.createGain();
          osc2.connect(gain2);
          gain2.connect(ctx.destination);
          osc2.type = config.type;
          osc2.frequency.value = config.freq;
          gain2.gain.setValueAtTime(volume, ctx.currentTime);
          gain2.gain.exponentialRampToValueAtTime(endValue, ctx.currentTime + config.duration);
          osc2.start(ctx.currentTime);
          osc2.stop(ctx.currentTime + config.duration);
        } catch (e) {
          console.error('[LLM Notify Offscreen] Error in double beep:', e);
        }
      }, config.duration * 1000 + 100);
    }

    oscillator.onended = () => {
      if (callback) callback();
    };
  } catch (error) {
    console.error('[LLM Notify Offscreen] Error playing tone:', error);
    if (callback) callback();
  }
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages meant for offscreen
  if (!message || !message.type) {
    return false;
  }

  console.log('[LLM Notify Offscreen] Received message:', message.type);

  switch (message.type) {
    case 'PING':
      // Verification that offscreen is alive
      console.log('[LLM Notify Offscreen] PING received, sending PONG');
      sendResponse({ success: true, pong: true });
      return true;

    case 'PLAY_SOUND':
      console.log('[LLM Notify Offscreen] Playing sound:', message.preset, 'volume:', message.volume, 'loop:', message.loop);
      try {
        playSoundWithPreset(message.preset, message.volume, message.loop);
        console.log('[LLM Notify Offscreen] Sound playback initiated');
        sendResponse({ success: true });
      } catch (err) {
        console.error('[LLM Notify Offscreen] Error playing sound:', err);
        sendResponse({ success: false, error: err.message });
      }
      return true;

    case 'UPDATE_VOLUME':
      console.log('[LLM Notify Offscreen] Update volume:', message.volume);
      sendResponse({ success: true });
      return true;

    case 'STOP_SOUND':
      console.log('[LLM Notify Offscreen] Stopping sound');
      stopAllSounds();
      sendResponse({ success: true });
      return true;

    default:
      // Not a message for us, let other listeners handle it
      return false;
  }
});

function playSoundWithPreset(preset, volume, loop = false) {
  console.log('[LLM Notify Offscreen] Playing:', preset, 'volume:', volume, 'loop:', loop);

  // Validate volume first
  if (typeof volume !== 'number' || isNaN(volume) || !isFinite(volume)) {
    console.warn('[LLM Notify Offscreen] Invalid volume in playSoundWithPreset, using 0.5:', volume);
    volume = 0.5;
  }
  volume = Math.max(0.01, Math.min(1, volume)); // Clamp between 0.01 and 1 (avoid 0 for exponentialRamp)

  // Handle custom sound
  if (preset === 'custom') {
    playCustomSound(volume, loop);
    return;
  }

  // Validate preset - must be string and exist in configs
  if (!preset || typeof preset !== 'string' || !soundConfigs[preset]) {
    console.warn('[LLM Notify Offscreen] Invalid preset, using chime:', preset);
    preset = 'chime';
  }

  // Stop any existing sounds
  stopAllSounds();

  // Get config for preset (now guaranteed to be valid)
  const config = soundConfigs[preset];

  if (loop) {
    isLooping = true;
    let currentVolume = volume;

    // Play immediately
    playGeneratedTone(config, currentVolume, null);

    // Calculate interval - play every (duration + small gap)
    const intervalMs = (config.duration * 1000) + 300; // 300ms gap between loops

    loopInterval = setInterval(() => {
      if (!isLooping) {
        clearInterval(loopInterval);
        return;
      }
      playGeneratedTone(config, currentVolume, null);
    }, intervalMs);

  } else {
    // Single play
    playGeneratedTone(config, volume, null);
  }
}

function stopAllSounds() {
  console.log('[LLM Notify Offscreen] Stopping all sounds');

  isLooping = false;

  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
  }

  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

// Handle custom sounds from storage
async function playCustomSound(volume, loop) {
  const { customSound } = await chrome.storage.local.get(['customSound']);

  if (customSound && customSound.data) {
    stopAllSounds();

    currentAudio = new Audio(customSound.data);
    currentAudio.volume = Math.min(Math.max(volume, 0), 1);
    currentAudio.loop = loop;

    try {
      await currentAudio.play();
    } catch (error) {
      console.error('[LLM Notify Offscreen] Custom sound error:', error);
      // Fallback to chime
      playSoundWithPreset('chime', volume, loop);
    }
  } else {
    // No custom sound, use default
    playSoundWithPreset('chime', volume, loop);
  }
}

console.log('[LLM Notify Offscreen] Audio handler initialized with 12 presets');
