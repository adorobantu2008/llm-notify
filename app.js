#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');

const PORT = 3847;
const DASHBOARD_URL = `http://localhost:${PORT}`;

// Check if port is in use (server already running)
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '127.0.0.1');
  });
}

// Open dashboard in browser
async function openDashboard() {
  try {
    const open = (await import('open')).default;
    await open(DASHBOARD_URL);
  } catch (e) {
    // Fallback for packaged app
    if (process.platform === 'darwin') {
      execSync(`open "${DASHBOARD_URL}"`, { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      execSync(`start "" "${DASHBOARD_URL}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${DASHBOARD_URL}"`, { stdio: 'ignore' });
    }
  }
}

async function start() {
  // Check if server is already running
  const alreadyRunning = await isPortInUse(PORT);

  if (alreadyRunning) {
    // Server already running - exit silently to avoid popup on notification click
    console.log('LLM Notify Hub is already running.');
    process.exit(0);
  }

  console.log('Starting LLM Notify Hub...');

  // Start the server
  require('./server/index.js');

  // Wait for server to be ready, then open dashboard
  function waitForServer(callback, attempts = 0) {
    if (attempts > 30) {
      console.error('Server failed to start');
      return;
    }

    http.get(`${DASHBOARD_URL}/api/health`, (res) => {
      if (res.statusCode === 200) {
        callback();
      } else {
        setTimeout(() => waitForServer(callback, attempts + 1), 200);
      }
    }).on('error', () => {
      setTimeout(() => waitForServer(callback, attempts + 1), 200);
    });
  }

  waitForServer(async () => {
    console.log('\n✓ LLM Notify Hub is running');
    console.log(`✓ Dashboard: ${DASHBOARD_URL}`);

    // Open dashboard in browser
    await openDashboard();

    console.log('\nDashboard opened in browser.');
    console.log('The app will continue running in the background.');
  });
}

start();
