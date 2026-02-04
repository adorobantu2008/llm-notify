// Audio Engine - Web Audio API based sound generation
// Matches the Chrome extension's sound presets

const AudioEngine = (() => {
  let audioContext = null;
  let loopInterval = null;
  let currentSource = null;

  // Sound presets configuration
  const presets = {
    // Gentle
    'chime': { freq: 880, duration: 0.4, type: 'sine', harmonics: true },
    'gentle-bell': { freq: 659, duration: 0.5, type: 'sine', harmonics: true },
    'calm-tone': { freq: 523, duration: 0.6, type: 'sine', harmonics: false },
    'ping': { freq: 1047, duration: 0.2, type: 'sine', harmonics: false },

    // Standard
    'bell': { freq: 784, duration: 0.4, type: 'sine', harmonics: true },
    'notification': { freq: 587, duration: 0.35, type: 'triangle', harmonics: false },
    'soft-alert': { freq: 698, duration: 0.3, type: 'sine', harmonics: true },

    // Attention-Grabbing
    'beep': { freq: 800, duration: 0.15, type: 'square', harmonics: false },
    'digital': { freq: 1200, duration: 0.2, type: 'square', harmonics: false },
    'double-beep': { freq: 900, duration: 0.1, type: 'square', double: true },
    'ascending': { freq: 400, duration: 0.5, type: 'sawtooth', ascending: true },
    'alert-urgent': { freq: 1000, duration: 0.25, type: 'sawtooth', harmonics: true }
  };

  function getContext() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
    return audioContext;
  }

  async function unlock() {
    const ctx = getContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    // Auto-suspend after inactivity to save resources
    resetSuspendTimer();
    return ctx.state;
  }

  let suspendTimer = null;
  function resetSuspendTimer() {
    if (suspendTimer) clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => {
      if (audioContext && audioContext.state === 'running' && !currentSource && !loopInterval) {
        audioContext.suspend();
      }
    }, 30000); // Suspend after 30s inactivity
  }

  function playTone(preset, volume = 0.5) {
    resetSuspendTimer();
    const config = presets[preset];
    if (!config) {
      console.warn('Unknown preset:', preset);
      return;
    }

    const ctx = getContext();
    const safeVolume = Math.max(0.01, Math.min(1, volume));

    if (config.double) {
      playDoubleTone(ctx, config, safeVolume);
    } else if (config.ascending) {
      playAscendingTone(ctx, config, safeVolume);
    } else {
      playSingleTone(ctx, config, safeVolume);
    }
  }

  function playSingleTone(ctx, config, volume) {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = config.type;
    oscillator.frequency.setValueAtTime(config.freq, ctx.currentTime);

    gainNode.gain.setValueAtTime(volume, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + config.duration);

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + config.duration);

    // Add harmonic if configured
    if (config.harmonics) {
      const harmonic = ctx.createOscillator();
      const harmonicGain = ctx.createGain();

      harmonic.type = config.type;
      harmonic.frequency.setValueAtTime(config.freq * 2, ctx.currentTime);

      harmonicGain.gain.setValueAtTime(volume * 0.3, ctx.currentTime);
      harmonicGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + config.duration * 0.8);

      harmonic.connect(harmonicGain);
      harmonicGain.connect(ctx.destination);

      harmonic.start(ctx.currentTime);
      harmonic.stop(ctx.currentTime + config.duration * 0.8);
    }
  }

  function playDoubleTone(ctx, config, volume) {
    playSingleTone(ctx, config, volume);
    setTimeout(() => {
      playSingleTone(ctx, config, volume);
    }, 150);
  }

  function playAscendingTone(ctx, config, volume) {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = config.type;
    oscillator.frequency.setValueAtTime(config.freq, ctx.currentTime);
    oscillator.frequency.linearRampToValueAtTime(config.freq * 2, ctx.currentTime + config.duration);

    gainNode.gain.setValueAtTime(volume, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + config.duration);

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + config.duration);
  }

  function startLoop(preset, volume = 0.5) {
    stopLoop();
    const config = presets[preset];
    if (!config) return;

    // Play immediately
    playTone(preset, volume);

    // Set up loop
    const interval = (config.duration + 0.3) * 1000;
    loopInterval = setInterval(() => {
      playTone(preset, volume);
    }, interval);
  }

  function stopLoop() {
    if (loopInterval) {
      clearInterval(loopInterval);
      loopInterval = null;
    }
  }

  function updateVolume(volume) {
    // Volume updates are handled by the next playTone call
    // For active alarms, we'd need to restart the loop
  }

  return {
    playTone,
    startLoop,
    stopLoop,
    updateVolume,
    getPresets: () => Object.keys(presets),
    unlock,
    getContext
  };
})();

// Export for use
window.AudioEngine = AudioEngine;
