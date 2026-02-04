"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
// Hub connection state
let hubConnected = false;
let statusBarItem;
let isGenerating = false;
let lastActivityTime = Date.now();
let checkInterval;
let pendingCompletionTimeout;
let currentSource = null;
let lastTerminalSource = null;
let lastTerminalActivity = 0;
let outputChannel;
let logWatcher = null;
let logFilePosition = 0;
let logFilePath = null;
let logWatcherRetry;
let claudeSawOutputLine = false;
let claudeAwaitingResponse = false;
let claudeStreamBuffer = '';
let claudeLastPromptIndex = -1;
let claudeLastOutputIndex = -1;
let claudeSsePollInterval;
let claudeSseSeenIds = new Set();
const MAX_PENDING_HUB_EVENTS = 50;
const HUB_ERROR_LOG_COOLDOWN_MS = 5000;
const HUB_BACKOFF_MAX_MS = 60000;
let pendingHubEvents = [];
let lastHubErrorAt = 0;
let lastHubErrorLogAt = 0;
let hubBackoffMs = 0;
let nextHubAttemptAt = 0;
let hubErrorBackoffMs = 5000;
const HUB_REQUIRED_NOTICE_COOLDOWN_MS = 60000;
let lastHubRequiredNoticeAt = 0;
// Claude debug directory watcher state
let claudeDebugWatcher = null;
let claudeDebugDir = null;
let claudeHistoryWatcher = null;
let claudeHistoryFile = null;
let claudeHistoryPosition = 0;
let claudeHistoryStartTime = 0;
let claudeHistoryCompletionTimeout = null;
let claudeHistoryPollInterval = null;
let claudeProjectWatcher = null;
let claudeProjectDir = null;
let claudeProjectWatcherStartedAt = 0;
const claudeProjectStates = new Map();
let claudeProjectPollInterval = null;
let claudeProjectScanInterval = null;
let debugFilePollInterval;
let debugFileStates = new Map(); // Track state per file
let lastCompletionTime = 0; // Cooldown to prevent rapid-fire notifications
const COMPLETION_COOLDOWN_MS = 0; // disabled to avoid missing short back-to-back prompts
const DEBUG_USER_PROMPT_WINDOW_MS = 2 * 60 * 1000;
// Codex sessions watcher state
let codexSessionsDir = null;
let codexSessionsPollInterval;
let codexSessionsWatcher = null;
let codexSessionStates = new Map();
let codexWatcherStartedAt = 0;
// Configuration
const HUB_URL = () => vscode.workspace.getConfiguration('llmNotify').get('hubUrl') || 'http://localhost:3847';
const isEnabled = () => vscode.workspace.getConfiguration('llmNotify').get('enabled') ?? true;
const showVSCodeNotification = () => vscode.workspace.getConfiguration('llmNotify').get('showVSCodeNotification') ?? true;
const detectClaudeCode = () => vscode.workspace.getConfiguration('llmNotify').get('detectClaudeCode') ?? true;
const detectCodex = () => vscode.workspace.getConfiguration('llmNotify').get('detectCodex') ?? true;
const claudePromptPattern = () => vscode.workspace.getConfiguration('llmNotify').get('claudePromptPattern') || '❯\\s';
const claudeOutputPattern = () => vscode.workspace.getConfiguration('llmNotify').get('claudeOutputPattern') || '(⏺|•|·)\\s';
const claudeCompletePattern = () => vscode.workspace.getConfiguration('llmNotify').get('claudeCompletePattern') || '✻\\s+Worked\\s+for';
const debugTerminalData = () => vscode.workspace.getConfiguration('llmNotify').get('debugTerminalData') ?? false;
const claudeLogPath = () => vscode.workspace.getConfiguration('llmNotify').get('claudeLogPath') || '';
const claudeSsePort = () => vscode.workspace.getConfiguration('llmNotify').get('claudeSsePort') || 0;
const codexSessionsPath = () => vscode.workspace.getConfiguration('llmNotify').get('codexSessionsDir') || '';
const CLAUDE_HISTORY_COMPLETION_MS = 120000;
const CLAUDE_TEXT_COMPLETION_MS = 8000; // Shorter timeout after seeing assistant text (not tool_use)
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('LLM Notify');
    context.subscriptions.push(outputChannel);
    log('Extension activated');
    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'llm-notify.openDashboard';
    context.subscriptions.push(statusBarItem);
    updateStatusBar('idle');
    // Register commands
    context.subscriptions.push(vscode.commands.registerCommand('llm-notify.testNotification', testNotification), vscode.commands.registerCommand('llm-notify.openDashboard', openDashboard), vscode.commands.registerCommand('llm-notify.toggleEnabled', toggleEnabled), vscode.commands.registerCommand('llm-notify.dismissAlarm', dismissAlarmCommand));
    // Monitor terminal activity
    setupTerminalMonitoring(context);
    setupLogWatcher(context);
    setupClaudeSseWatcher(context);
    setupClaudeDebugWatcher(context);
    setupClaudeHistoryWatcher(context);
    setupClaudeProjectsWatcher(context);
    setupCodexSessionsWatcher(context);
    // Monitor active editor changes (Claude Code often triggers these)
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
        if (isGenerating && !hasReliableDetectors()) {
            checkForCompletion();
        }
    }));
    // Monitor file save events (Claude Code saves files)
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => {
        if (isGenerating) {
            // File was saved, might be Claude Code finishing
            lastActivityTime = Date.now();
        }
    }));
    // Monitor file changes
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
        // Check if this looks like automated editing (Claude Code)
        if (e.contentChanges.length > 0) {
            const changeSize = e.contentChanges.reduce((acc, c) => acc + c.text.length, 0);
            // Large automated changes suggest Claude Code is working
            if (changeSize > 50 && !hasReliableDetectors()) {
                markGenerating();
                lastActivityTime = Date.now();
            }
        }
    }));
    // Check hub connection periodically
    checkHubConnection();
    setInterval(checkHubConnection, 10000);
    // Start completion detection polling
    startCompletionPolling();
    log('Monitoring started');
}
function setupTerminalMonitoring(context) {
    // Monitor terminal creation
    context.subscriptions.push(vscode.window.onDidOpenTerminal((terminal) => {
        log(`Terminal opened: ${terminal.name}`);
        monitorTerminal(terminal);
    }));
    // Monitor terminal close
    context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
        log(`Terminal closed: ${terminal.name}`);
        // If agent terminal closes while generating, it might be done
        if (isGenerating && isAgentTerminal(terminal)) {
            triggerCompletion();
        }
    }));
    // Monitor existing terminals
    vscode.window.terminals.forEach(monitorTerminal);
    // Monitor terminal shell execution (stable API, best fallback when data event is unavailable)
    const startExecEvent = vscode.window.onDidStartTerminalShellExecution;
    if (startExecEvent) {
        log('Terminal shell execution start event available');
        context.subscriptions.push(startExecEvent((event) => {
            const source = getExecutionSource(event.execution?.commandLine) || getTerminalSource(event.terminal);
            if (!source)
                return;
            if (logFilePath) {
                return;
            }
            lastTerminalSource = source;
            lastTerminalActivity = Date.now();
            lastActivityTime = lastTerminalActivity;
            if (source === 'claude-code') {
                claudeAwaitingResponse = true;
                return;
            }
            markGenerating(source);
        }));
    }
    else {
        log('Terminal shell execution start event NOT available');
    }
    const endExecEvent = vscode.window.onDidEndTerminalShellExecution;
    if (endExecEvent) {
        log('Terminal shell execution end event available');
        context.subscriptions.push(endExecEvent((event) => {
            const source = getExecutionSource(event.execution?.commandLine) || getTerminalSource(event.terminal);
            if (!source || !isGenerating)
                return;
            if (!currentSource) {
                currentSource = source;
            }
            if (logFilePath) {
                return;
            }
            if (source === 'claude-code') {
                return;
            }
            scheduleCompletionCheck();
        }));
    }
    else {
        log('Terminal shell execution end event NOT available');
    }
    if (!startExecEvent && !endExecEvent) {
        log('No terminal shell execution APIs available; use log file fallback.');
    }
    // Monitor terminal state changes
    context.subscriptions.push(vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (terminal && isAgentTerminal(terminal)) {
            lastActivityTime = Date.now();
            lastTerminalActivity = lastActivityTime;
            lastTerminalSource = getTerminalSource(terminal);
        }
    }));
}
function setupLogWatcher(context) {
    log(`Log watcher init, path="${claudeLogPath()}"`);
    startLogWatcher();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('llmNotify.claudeLogPath')) {
            log(`Log path changed, new path="${claudeLogPath()}"`);
            startLogWatcher();
        }
    }));
}
function setupClaudeSseWatcher(context) {
    startClaudeSseWatcher();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('llmNotify.claudeSsePort')) {
            startClaudeSseWatcher();
        }
    }));
}
function startClaudeSseWatcher() {
    if (claudeSsePollInterval) {
        clearInterval(claudeSsePollInterval);
        claudeSsePollInterval = undefined;
    }
    const port = claudeSsePort();
    if (!port) {
        log('Claude SSE watcher disabled (no port set)');
        return;
    }
    const sseUrl = `http://127.0.0.1:${port}/events`;
    log(`Claude SSE watcher active: ${sseUrl}`);
    claudeSsePollInterval = setInterval(() => {
        fetchClaudeSseOnce(sseUrl);
    }, 1000);
}
function fetchClaudeSseOnce(url) {
    http.get(url, (res) => {
        if (res.statusCode !== 200) {
            res.resume();
            return;
        }
        let buffer = '';
        res.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
        });
        res.on('end', () => {
            const events = buffer.split('\n\n');
            for (const raw of events) {
                const lines = raw.split('\n').filter(Boolean);
                const dataLine = lines.find((line) => line.startsWith('data:'));
                if (!dataLine)
                    continue;
                const payload = dataLine.replace(/^data:\s*/, '');
                if (!payload)
                    continue;
                let parsed = null;
                try {
                    parsed = JSON.parse(payload);
                }
                catch {
                    continue;
                }
                if (!parsed)
                    continue;
                const eventId = parsed.id || payload;
                if (claudeSseSeenIds.has(eventId))
                    continue;
                claudeSseSeenIds.add(eventId);
                if (claudeSseSeenIds.size > 2000) {
                    claudeSseSeenIds = new Set(Array.from(claudeSseSeenIds).slice(-1000));
                }
                if (parsed.type === 'start' || parsed.type === 'generating') {
                    markGenerating('claude-code');
                }
                if (parsed.type === 'complete' || parsed.type === 'done') {
                    triggerCompletion();
                }
            }
        });
    }).on('error', () => { });
}
// ============================================================================
// Claude Debug Directory Watcher - Primary detection mechanism
// ============================================================================
// This watches ~/.claude/debug/ for file changes, which is updated in real-time
// when Claude Code is running. This is the most reliable detection method since
// VS Code does NOT provide access to terminal output data.
function setupClaudeDebugWatcher(context) {
    claudeDebugDir = path.join(os.homedir(), '.claude', 'debug');
    log(`Setting up Claude debug watcher at: ${claudeDebugDir}`);
    startClaudeDebugWatcher();
    // Re-check periodically for new debug files (sessions)
    const recheckInterval = setInterval(() => {
        findAndWatchLatestDebugFile();
    }, 5000);
    context.subscriptions.push({
        dispose: () => {
            clearInterval(recheckInterval);
            stopClaudeDebugWatcher();
        }
    });
}
function startClaudeDebugWatcher() {
    if (!claudeDebugDir)
        return;
    // Check if debug directory exists
    fs.promises.access(claudeDebugDir, fs.constants.R_OK)
        .then(() => {
        log('Claude debug directory found, starting watcher');
        // Watch the directory for new files
        try {
            const dirToWatch = claudeDebugDir;
            claudeDebugWatcher = fs.watch(dirToWatch, { persistent: false }, (eventType, filename) => {
                if (eventType === 'rename' && filename && filename.endsWith('.txt')) {
                    // New debug file created - likely a new Claude session
                    log(`New debug file detected: ${filename}`);
                    setTimeout(() => findAndWatchLatestDebugFile(), 100);
                }
            });
        }
        catch (err) {
            log(`Could not watch debug directory: ${err.message}`);
        }
        // Find and watch the most recent debug file
        findAndWatchLatestDebugFile();
    })
        .catch(() => {
        log('Claude debug directory not found - Claude Code may not be installed');
        // Retry periodically
        setTimeout(startClaudeDebugWatcher, 10000);
    });
}
// ============================================================================
// Claude History Watcher - Detects Claude Code in VS Code extension
// ============================================================================
function setupClaudeHistoryWatcher(context) {
    const historyPath = path.join(os.homedir(), '.claude', 'history.jsonl');
    claudeHistoryFile = historyPath;
    claudeHistoryStartTime = Date.now();
    log(`Setting up Claude history watcher at: ${historyPath}`);
    startClaudeHistoryWatcher();
    context.subscriptions.push({
        dispose: () => {
            stopClaudeHistoryWatcher();
        }
    });
}
function stopClaudeHistoryWatcher() {
    if (claudeHistoryWatcher) {
        claudeHistoryWatcher.close();
        claudeHistoryWatcher = null;
    }
    if (claudeHistoryPollInterval) {
        clearInterval(claudeHistoryPollInterval);
        claudeHistoryPollInterval = null;
    }
    if (claudeHistoryCompletionTimeout) {
        clearTimeout(claudeHistoryCompletionTimeout);
        claudeHistoryCompletionTimeout = null;
    }
}
function clearClaudeHistoryCompletionTimeout() {
    if (claudeHistoryCompletionTimeout) {
        clearTimeout(claudeHistoryCompletionTimeout);
        claudeHistoryCompletionTimeout = null;
    }
}
function scheduleClaudeHistoryCompletion() {
    clearClaudeHistoryCompletionTimeout();
    claudeHistoryCompletionTimeout = setTimeout(() => {
        if (isGenerating && resolveActiveSource() === 'claude-code') {
            log('Claude history idle timeout - completing');
            triggerCompletion();
        }
    }, CLAUDE_HISTORY_COMPLETION_MS);
}
function scheduleClaudeTextCompletion() {
    // Shorter timeout when we see actual text content (not just tool_use)
    // This indicates Claude is producing the final response
    clearClaudeHistoryCompletionTimeout();
    claudeHistoryCompletionTimeout = setTimeout(() => {
        if (isGenerating && resolveActiveSource() === 'claude-code') {
            log('Claude text content idle timeout - completing');
            triggerCompletion();
        }
    }, CLAUDE_TEXT_COMPLETION_MS);
}
function startClaudeHistoryWatcher() {
    if (!claudeHistoryFile || !detectClaudeCode())
        return;
    fs.promises.stat(claudeHistoryFile)
        .then((stat) => {
        log(`Claude history found, size=${stat.size}`);
        claudeHistoryPosition = stat.size;
        try {
            claudeHistoryWatcher = fs.watch(claudeHistoryFile, { persistent: false }, (eventType) => {
                if (eventType === 'change') {
                    readClaudeHistoryUpdates();
                }
            });
        }
        catch (err) {
            log(`Could not watch Claude history: ${err.message}`);
        }
    })
        .catch(() => {
        log('Claude history file not found yet');
        // History file may not exist yet
        setTimeout(startClaudeHistoryWatcher, 10000);
    });
    if (!claudeHistoryPollInterval) {
        claudeHistoryPollInterval = setInterval(readClaudeHistoryUpdates, 1500);
    }
}
async function readClaudeHistoryUpdates() {
    if (!claudeHistoryFile)
        return;
    try {
        const stat = await fs.promises.stat(claudeHistoryFile);
        if (stat.size < claudeHistoryPosition) {
            claudeHistoryPosition = 0;
        }
        if (stat.size <= claudeHistoryPosition)
            return;
        log(`Claude history changed: ${claudeHistoryPosition} -> ${stat.size}`);
        const fd = await fs.promises.open(claudeHistoryFile, 'r');
        const length = stat.size - claudeHistoryPosition;
        const buffer = Buffer.alloc(length);
        await fd.read(buffer, 0, length, claudeHistoryPosition);
        await fd.close();
        claudeHistoryPosition = stat.size;
        const newContent = buffer.toString('utf8');
        processClaudeHistoryContent(newContent);
    }
    catch {
        // ignore read errors
    }
}
function processClaudeHistoryContent(content) {
    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines) {
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        const display = (entry?.display || '').toString().trim();
        const ts = typeof entry?.timestamp === 'number' ? entry.timestamp : Date.parse(entry?.timestamp || '');
        if (!display)
            continue;
        if (Number.isNaN(ts))
            continue;
        if (ts < claudeHistoryStartTime)
            continue;
        setCurrentSource('claude-code');
        if (!isGenerating) {
            log('Claude history prompt detected - generation starting');
            markGenerating('claude-code');
        }
        lastActivityTime = Date.now();
        scheduleClaudeHistoryCompletion();
    }
}
function stopClaudeDebugWatcher() {
    if (claudeDebugWatcher) {
        claudeDebugWatcher.close();
        claudeDebugWatcher = null;
    }
    if (debugFilePollInterval) {
        clearInterval(debugFilePollInterval);
        debugFilePollInterval = undefined;
    }
}
async function findAndWatchLatestDebugFile() {
    if (!claudeDebugDir)
        return;
    try {
        const files = await fs.promises.readdir(claudeDebugDir);
        const txtFiles = files.filter(f => f.endsWith('.txt'));
        if (txtFiles.length === 0) {
            log('No debug files found yet');
            return;
        }
        // Get file stats to find recently modified files (within last 5 minutes)
        const now = Date.now();
        const fiveMinutesAgo = now - 5 * 60 * 1000;
        const fileStats = await Promise.all(txtFiles.map(async (f) => {
            const filePath = path.join(claudeDebugDir, f);
            try {
                const stat = await fs.promises.stat(filePath);
                return { file: filePath, mtime: stat.mtime.getTime(), size: stat.size };
            }
            catch {
                return null;
            }
        }));
        const validFiles = fileStats.filter((f) => f !== null);
        if (validFiles.length === 0)
            return;
        // Get files modified in last 5 minutes (could be multiple Claude sessions)
        const recentFiles = validFiles.filter(f => f.mtime > fiveMinutesAgo);
        // Initialize positions for new files only (don't reset existing ones!)
        for (const file of recentFiles) {
            if (!debugFileStates.has(file.file)) {
                debugFileStates.set(file.file, {
                    position: file.size,
                    lastUserPromptAt: 0,
                    isGenerating: false,
                    lastActivityAt: 0
                });
                log(`Now tracking debug file: ${path.basename(file.file)}`);
            }
        }
        // Clean up old files from tracking (not modified in 10 minutes)
        const tenMinutesAgo = now - 10 * 60 * 1000;
        for (const [filePath] of debugFileStates) {
            const fileInfo = validFiles.find(f => f.file === filePath);
            if (!fileInfo || fileInfo.mtime < tenMinutesAgo) {
                debugFileStates.delete(filePath);
            }
        }
        // Start polling all tracked files
        startDebugFilePoll();
    }
    catch (err) {
        log(`Error finding debug files: ${err.message}`);
    }
}
function startDebugFilePoll() {
    // Clear existing poll if any
    if (debugFilePollInterval) {
        clearInterval(debugFilePollInterval);
    }
    // Poll ALL tracked debug files for changes
    debugFilePollInterval = setInterval(async () => {
        if (debugFileStates.size === 0)
            return;
        for (const [filePath, state] of debugFileStates) {
            try {
                const stat = await fs.promises.stat(filePath);
                // File has grown - read new content
                if (stat.size > state.position) {
                    const fd = await fs.promises.open(filePath, 'r');
                    const length = stat.size - state.position;
                    const buffer = Buffer.alloc(length);
                    await fd.read(buffer, 0, length, state.position);
                    await fd.close();
                    // Update position for this specific file
                    state.position = stat.size;
                    const newContent = buffer.toString('utf8');
                    // Process the new debug log content
                    processDebugLogContent(filePath, newContent);
                }
            }
            catch {
                // File might have been deleted, remove from tracking
                debugFileStates.delete(filePath);
            }
        }
    }, 500); // Poll every 500ms for responsive detection
}
function anyDebugFileGenerating() {
    for (const state of debugFileStates.values()) {
        if (state.isGenerating)
            return true;
    }
    return false;
}
// ============================================================================
// Codex Sessions Watcher - Detects Codex CLI + VS Code chat via session logs
// ============================================================================
function setupCodexSessionsWatcher(context) {
    const configured = codexSessionsPath().trim();
    codexSessionsDir = configured || path.join(os.homedir(), '.codex', 'sessions');
    log(`Setting up Codex sessions watcher at: ${codexSessionsDir}`);
    codexWatcherStartedAt = Date.now();
    startCodexSessionsWatcher();
    const recheckInterval = setInterval(() => {
        findAndWatchCodexSessionFiles();
    }, 5000);
    context.subscriptions.push({
        dispose: () => {
            clearInterval(recheckInterval);
            stopCodexSessionsWatcher();
        }
    });
}
function startCodexSessionsWatcher() {
    if (!codexSessionsDir)
        return;
    fs.promises.access(codexSessionsDir, fs.constants.R_OK)
        .then(() => {
        log('Codex sessions directory found, starting watcher');
        try {
            const dirToWatch = codexSessionsDir;
            codexSessionsWatcher = fs.watch(dirToWatch, { persistent: false }, (eventType, filename) => {
                if (eventType === 'rename' && filename && filename.endsWith('.jsonl')) {
                    log(`New Codex session file detected: ${filename}`);
                    setTimeout(() => findAndWatchCodexSessionFiles(), 100);
                }
            });
        }
        catch (err) {
            log(`Could not watch Codex sessions directory: ${err.message}`);
        }
        findAndWatchCodexSessionFiles();
    })
        .catch(() => {
        log('Codex sessions directory not found');
        setTimeout(startCodexSessionsWatcher, 10000);
    });
}
function stopCodexSessionsWatcher() {
    if (codexSessionsWatcher) {
        codexSessionsWatcher.close();
        codexSessionsWatcher = null;
    }
    if (codexSessionsPollInterval) {
        clearInterval(codexSessionsPollInterval);
        codexSessionsPollInterval = undefined;
    }
}
async function findAndWatchCodexSessionFiles() {
    if (!codexSessionsDir)
        return;
    try {
        const files = await listJsonlFiles(codexSessionsDir);
        if (files.length === 0)
            return;
        const now = Date.now();
        const fiveMinutesAgo = now - 5 * 60 * 1000;
        const tenMinutesAgo = now - 10 * 60 * 1000;
        const fileStats = await Promise.all(files.map(async (filePath) => {
            try {
                const stat = await fs.promises.stat(filePath);
                return { file: filePath, mtime: stat.mtime.getTime(), size: stat.size };
            }
            catch {
                return null;
            }
        }));
        const validFiles = fileStats.filter((f) => f !== null);
        const recentFiles = validFiles.filter(f => f.mtime > fiveMinutesAgo);
        for (const file of recentFiles) {
            if (!codexSessionStates.has(file.file)) {
                codexSessionStates.set(file.file, {
                    position: file.size,
                    lastUserPromptAt: 0,
                    isGenerating: false,
                    lastActivityAt: 0,
                    lastSeenAt: Date.now(),
                    buffer: '',
                    startTime: codexWatcherStartedAt
                });
                log(`Now tracking Codex session file: ${path.basename(file.file)}`);
            }
        }
        for (const [filePath, existingState] of codexSessionStates) {
            const fileInfo = validFiles.find(f => f.file === filePath);
            if (!fileInfo || fileInfo.mtime < tenMinutesAgo) {
                const wasGenerating = existingState.isGenerating;
                codexSessionStates.delete(filePath);
                if (wasGenerating && !anyCodexSessionGenerating()) {
                    stopGeneratingSilently('codex');
                }
            }
        }
        startCodexSessionsPoll();
    }
    catch (err) {
        log(`Error finding Codex session files: ${err.message}`);
    }
}
function startCodexSessionsPoll() {
    if (codexSessionsPollInterval) {
        clearInterval(codexSessionsPollInterval);
    }
    codexSessionsPollInterval = setInterval(async () => {
        if (codexSessionStates.size === 0)
            return;
        for (const [filePath, state] of codexSessionStates) {
            try {
                const stat = await fs.promises.stat(filePath);
                if (stat.size > state.position) {
                    const fd = await fs.promises.open(filePath, 'r');
                    const length = stat.size - state.position;
                    const buffer = Buffer.alloc(length);
                    await fd.read(buffer, 0, length, state.position);
                    await fd.close();
                    state.position = stat.size;
                    const newContent = buffer.toString('utf8');
                    processCodexSessionContent(filePath, newContent);
                }
            }
            catch {
                codexSessionStates.delete(filePath);
            }
        }
    }, 500);
}
function anyCodexSessionGenerating() {
    for (const state of codexSessionStates.values()) {
        if (state.isGenerating)
            return true;
    }
    return false;
}
function hasReliableDetectors() {
    return Boolean(logFilePath || debugFileStates.size > 0 || codexSessionStates.size > 0);
}
function setCurrentSource(source) {
    currentSource = source;
    if (isGenerating) {
        updateStatusBar('generating');
    }
}
function resolveActiveSource() {
    if (anyCodexSessionGenerating())
        return 'codex';
    if (anyDebugFileGenerating())
        return 'claude-code';
    return currentSource || resolveCurrentSource();
}
function processCodexSessionContent(filePath, content, minTimestamp) {
    const state = codexSessionStates.get(filePath);
    if (!state)
        return;
    const text = (state.buffer || '') + content;
    const parts = text.split('\n');
    if (text.endsWith('\n')) {
        state.buffer = '';
    }
    else {
        state.buffer = parts.pop() || '';
    }
    const lines = parts.filter(l => l.trim());
    for (const line of lines) {
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        const entryType = (entry?.payload?.type || entry?.type || '').toString().toLowerCase();
        const entryMessage = (entry?.payload?.message || '').toString().toLowerCase();
        const parsedTimestamp = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
        if (minTimestamp && (Number.isNaN(parsedTimestamp) || parsedTimestamp < minTimestamp)) {
            continue;
        }
        const entryTimestamp = Number.isNaN(parsedTimestamp) ? Date.now() : parsedTimestamp;
        const isUserEventMessage = entry?.type === 'event_msg' && entry?.payload?.type === 'user_message';
        const isUserResponseItem = entry?.type === 'response_item' && entry?.payload?.role === 'user' && Array.isArray(entry?.payload?.content);
        // Only treat response_item user entries as a real submission.
        // event_msg user_message fires on focus/typing in some Codex clients.
        if (isUserResponseItem) {
            const userCutoff = state.startTime ?? codexWatcherStartedAt;
            if (userCutoff && entryTimestamp < userCutoff) {
                continue;
            }
            const messageText = (entry?.payload?.message ?? entry?.payload?.content?.[0]?.text ?? '').toString().trim();
            if (!messageText) {
                continue;
            }
            // Ignore synthetic/system context blobs that some Codex clients emit as user messages.
            const lowerMessage = messageText.toLowerCase();
            if (lowerMessage.startsWith('# agents.md instructions') ||
                lowerMessage.startsWith('<environment_context>') ||
                lowerMessage.startsWith('<instructions>') ||
                lowerMessage.includes('## skills') ||
                lowerMessage.includes('## how to use skills')) {
                continue;
            }
            state.lastUserPromptAt = Number.isNaN(entryTimestamp) ? Date.now() : entryTimestamp;
            state.lastActivityAt = Date.now();
            setCurrentSource('codex');
            if (!state.isGenerating) {
                log('Codex user message detected - generation starting');
                const started = markGenerating('codex');
                if (started) {
                    state.isGenerating = true;
                }
            }
            lastActivityTime = Date.now();
            continue;
        }
        if (isUserEventMessage) {
            // Ignore event_msg user_message to avoid false starts.
            continue;
        }
        const isAssistantMessage = (entry?.type === 'event_msg' && entry?.payload?.type === 'agent_message' && !!entry?.payload?.message) ||
            (entry?.type === 'response_item' && entry?.payload?.role === 'assistant' && Array.isArray(entry?.payload?.content));
        const isCancelEvent = entryType.includes('turn_aborted') ||
            entryType.includes('cancel') ||
            entryType.includes('stop_generation') ||
            entryType.includes('abort') ||
            entryMessage.includes('cancelled') ||
            entryMessage.includes('canceled') ||
            entryMessage.includes('interrupted');
        if (isCancelEvent && state.isGenerating) {
            state.isGenerating = false;
            if (!anyCodexSessionGenerating()) {
                stopGeneratingSilently('codex');
            }
            continue;
        }
        if (isAssistantMessage && state.isGenerating) {
            lastActivityTime = Date.now();
            state.isGenerating = false;
            if (!anyCodexSessionGenerating()) {
                log('Codex assistant message detected - completing');
                triggerCompletion();
            }
        }
    }
}
async function listJsonlFiles(root) {
    const results = [];
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries = [];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
            }
            else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                results.push(fullPath);
            }
        }
    }
    return results;
}
function processDebugLogContent(filePath, content) {
    const state = debugFileStates.get(filePath);
    if (!state)
        return;
    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines) {
        // =====================================================================
        // RELIABLE START PATTERNS - Only trigger on actual user query submission
        // =====================================================================
        // "UserPromptSubmit" - fires when user submits a query
        const isDefiniteStart = line.includes('UserPromptSubmit');
        if (isDefiniteStart) {
            state.lastUserPromptAt = Date.now();
            state.lastActivityAt = state.lastUserPromptAt;
            if (!state.isGenerating) {
                log('Claude query submitted - generation starting');
                const started = markGenerating('claude-code');
                if (started) {
                    state.isGenerating = true;
                }
            }
            lastActivityTime = Date.now();
        }
        // =====================================================================
        // ACTIVITY PATTERNS - Keep the activity timestamp updated while working
        // =====================================================================
        const isActivityPattern = line.includes('Stream started - received first chunk') ||
            (line.includes('MCP server') && line.includes('Tool ')) ||
            line.includes('FileHistory: Making snapshot');
        if (isActivityPattern && state.isGenerating) {
            state.lastActivityAt = Date.now();
            lastActivityTime = Date.now();
        }
        // =====================================================================
        // RELIABLE COMPLETION PATTERNS - These indicate Claude finished
        // =====================================================================
        // "Stopped caffeinate" - Claude finished processing, allowing sleep again
        // This is the most reliable completion signal as it only fires when Claude is truly done.
        // NOTE: We removed "hook commands for Stop" as it fires for subagent completions (Task tool)
        // which caused false positives during complex multi-step operations.
        const isDefiniteComplete = line.includes('Stopped caffeinate, allowing sleep');
        if (isDefiniteComplete && state.isGenerating) {
            const now = Date.now();
            if (now - state.lastUserPromptAt > DEBUG_USER_PROMPT_WINDOW_MS) {
                continue;
            }
            log('Debug log: Claude stopped processing - completing');
            state.isGenerating = false;
            if (!anyDebugFileGenerating()) {
                // Trigger completion immediately since this is a definite signal
                clearClaudeHistoryCompletionTimeout();
                triggerCompletion();
            }
        }
        // Session end detection
        if ((line.includes('SessionEnd') || line.includes('prompt_input_exit')) && state.isGenerating) {
            state.isGenerating = false;
            if (!anyDebugFileGenerating()) {
                log('Debug log: Session ending - completing');
                clearClaudeHistoryCompletionTimeout();
                triggerCompletion();
            }
        }
    }
}
// ============================================================================
// Claude Projects Watcher - Detects Claude Code in VS Code chat sessions
// ============================================================================
function setupClaudeProjectsWatcher(context) {
    claudeProjectDir = path.join(os.homedir(), '.claude', 'projects');
    log(`Setting up Claude projects watcher at: ${claudeProjectDir}`);
    startClaudeProjectsWatcher();
    context.subscriptions.push({
        dispose: () => {
            stopClaudeProjectsWatcher();
        }
    });
}
function stopClaudeProjectsWatcher() {
    if (claudeProjectWatcher) {
        claudeProjectWatcher.close();
        claudeProjectWatcher = null;
    }
    if (claudeProjectPollInterval) {
        clearInterval(claudeProjectPollInterval);
        claudeProjectPollInterval = null;
    }
    if (claudeProjectScanInterval) {
        clearInterval(claudeProjectScanInterval);
        claudeProjectScanInterval = null;
    }
    claudeProjectStates.clear();
}
function startClaudeProjectsWatcher() {
    if (!claudeProjectDir || !detectClaudeCode())
        return;
    claudeProjectWatcherStartedAt = Date.now();
    fs.promises.access(claudeProjectDir, fs.constants.R_OK)
        .then(() => {
        try {
            claudeProjectWatcher = fs.watch(claudeProjectDir, { persistent: false }, (eventType, filename) => {
                if (eventType === 'rename' || eventType === 'change') {
                    findAndWatchClaudeProjectFiles();
                }
            });
        }
        catch (err) {
            log(`Could not watch Claude projects: ${err.message}`);
        }
        findAndWatchClaudeProjectFiles();
        if (!claudeProjectScanInterval) {
            claudeProjectScanInterval = setInterval(findAndWatchClaudeProjectFiles, 5000);
        }
    })
        .catch(() => {
        setTimeout(startClaudeProjectsWatcher, 10000);
    });
}
async function findAndWatchClaudeProjectFiles() {
    if (!claudeProjectDir)
        return;
    try {
        const files = await listJsonlFiles(claudeProjectDir);
        if (!files.length)
            return;
        const now = Date.now();
        const tenMinutesAgo = now - 10 * 60 * 1000;
        const root = claudeProjectDir;
        for (const file of files) {
            if (claudeProjectStates.has(file))
                continue;
            const rel = path.relative(root, file);
            if (rel.includes(`${path.sep}subagents${path.sep}`))
                continue;
            if (rel.split(path.sep).length !== 2)
                continue; // only project/session.jsonl
            let stat;
            try {
                stat = await fs.promises.stat(file);
            }
            catch {
                continue;
            }
            if (stat.mtime.getTime() < tenMinutesAgo)
                continue;
            const isPreExisting = stat.mtime.getTime() < claudeProjectWatcherStartedAt;
            const startPos = isPreExisting ? stat.size : 0;
            // New session file: read from start only if created after watcher start.
            claudeProjectStates.set(file, { position: startPos, buffer: '' });
            log(`Now tracking Claude project file: ${path.basename(file)}`);
            // Immediately read existing content once (first prompt may already exist).
            if (!isPreExisting) {
                readClaudeProjectUpdates();
            }
        }
        if (!claudeProjectPollInterval) {
            claudeProjectPollInterval = setInterval(readClaudeProjectUpdates, 1500);
        }
    }
    catch {
        // ignore errors
    }
}
async function readClaudeProjectUpdates() {
    for (const [filePath, state] of claudeProjectStates) {
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.size < state.position) {
                state.position = 0;
            }
            if (stat.size <= state.position)
                continue;
            const fd = await fs.promises.open(filePath, 'r');
            const length = stat.size - state.position;
            const buffer = Buffer.alloc(length);
            await fd.read(buffer, 0, length, state.position);
            await fd.close();
            state.position = stat.size;
            const newContent = buffer.toString('utf8');
            processClaudeProjectContent(state, newContent);
        }
        catch {
            claudeProjectStates.delete(filePath);
        }
    }
}
function extractClaudeProjectUserText(entry) {
    const parts = entry?.message?.content;
    if (!Array.isArray(parts))
        return '';
    const textParts = parts
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text.trim())
        .filter(Boolean);
    if (!textParts.length)
        return '';
    // Ignore IDE opened file markers if present; take the last meaningful text.
    const filtered = textParts.filter(t => !t.startsWith('<ide_opened_file>'));
    return (filtered.length ? filtered[filtered.length - 1] : textParts[textParts.length - 1]).trim();
}
function processClaudeProjectContent(state, content) {
    const text = state.buffer + content;
    const parts = text.split('\n');
    if (text.endsWith('\n')) {
        state.buffer = '';
    }
    else {
        state.buffer = parts.pop() || '';
    }
    const lines = parts.filter(l => l.trim());
    for (const line of lines) {
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (entry?.isSidechain === true)
            continue;
        const type = entry?.type;
        if (type === 'user' && entry?.message?.role === 'user') {
            if (entry?.userType && entry.userType !== 'external')
                continue;
            const msgText = extractClaudeProjectUserText(entry);
            if (!msgText)
                continue;
            if (msgText.includes('[SUGGESTION MODE') || msgText.includes('<INSTRUCTIONS>') || msgText.includes('<environment_context>')) {
                continue;
            }
            setCurrentSource('claude-code');
            if (!isGenerating) {
                log('Claude project prompt detected - generation starting');
                markGenerating('claude-code');
            }
            lastActivityTime = Date.now();
            scheduleClaudeHistoryCompletion();
        }
        else if (type === 'assistant' && isGenerating && resolveActiveSource() === 'claude-code') {
            // Assistant messages are written incrementally during generation.
            // Check if this message has text content (not just tool_use or thinking).
            // Text content means Claude is producing the final response.
            lastActivityTime = Date.now();
            const messageContent = entry?.message?.content;
            const hasTextContent = Array.isArray(messageContent) &&
                messageContent.some((c) => c?.type === 'text' && c?.text?.trim());
            if (hasTextContent) {
                // Claude is producing text output - use shorter completion timeout
                scheduleClaudeTextCompletion();
            }
            else {
                // Still using tools or thinking - use longer timeout
                scheduleClaudeHistoryCompletion();
            }
        }
    }
}
function startLogWatcher() {
    const nextPath = claudeLogPath().trim();
    log(`Start log watcher called, raw path="${nextPath}"`);
    if (logWatcher) {
        logWatcher.close();
        logWatcher = null;
    }
    if (logWatcherRetry) {
        clearTimeout(logWatcherRetry);
        logWatcherRetry = undefined;
    }
    logFilePosition = 0;
    logFilePath = nextPath || null;
    if (!logFilePath) {
        log('Log watcher disabled (no claudeLogPath set)');
        return;
    }
    tryInitializeLogWatcher();
}
function tryInitializeLogWatcher() {
    if (!logFilePath)
        return;
    fs.promises.stat(logFilePath).then((stat) => {
        logFilePosition = stat.size;
        log(`Log watcher active: ${logFilePath}`);
        const watchPath = logFilePath;
        logWatcher = fs.watch(watchPath, { persistent: true }, (eventType) => {
            if (eventType !== 'change')
                return;
            readLogFileAppend();
        });
    }).catch(() => {
        log(`Log file not found yet: ${logFilePath}`);
        logWatcherRetry = setTimeout(tryInitializeLogWatcher, 2000);
    });
}
async function readLogFileAppend() {
    if (!logFilePath)
        return;
    try {
        const stat = await fs.promises.stat(logFilePath);
        if (stat.size < logFilePosition) {
            logFilePosition = 0;
        }
        if (stat.size === logFilePosition) {
            return;
        }
        const length = stat.size - logFilePosition;
        const fd = await fs.promises.open(logFilePath, 'r');
        const buffer = Buffer.alloc(length);
        await fd.read(buffer, 0, length, logFilePosition);
        await fd.close();
        logFilePosition = stat.size;
        const data = buffer.toString('utf8');
        const source = detectSourceFromData(data) || 'claude-code';
        handleTerminalData(data, source);
    }
    catch (error) {
        log(`Log watcher read error: ${error.message}`);
    }
}
function monitorTerminal(terminal) {
    const source = getTerminalSource(terminal);
    if (source) {
        log(`Monitoring agent terminal: ${terminal.name} source: ${source}`);
        lastTerminalSource = source;
        lastTerminalActivity = Date.now();
    }
}
function isClaudeCodeTerminal(terminal) {
    if (!detectClaudeCode())
        return false;
    const name = terminal.name.toLowerCase();
    return name.includes('claude') ||
        name.includes('anthropic') ||
        name.includes('claude code') ||
        name.includes('mcp') ||
        name.includes('task');
}
function isCodexTerminal(terminal) {
    if (!detectCodex())
        return false;
    const name = terminal.name.toLowerCase();
    return name.includes('codex') ||
        name.includes('openai') ||
        name.includes('gpt') ||
        name.includes('chatgpt');
}
function isAgentTerminal(terminal) {
    return isClaudeCodeTerminal(terminal) || isCodexTerminal(terminal);
}
function getTerminalSource(terminal) {
    if (isCodexTerminal(terminal))
        return 'codex';
    if (isClaudeCodeTerminal(terminal))
        return 'claude-code';
    return null;
}
function startCompletionPolling() {
    // Poll for completion - ONLY as a fallback safety net
    // The debug watcher provides reliable completion signals, so this is just backup
    checkInterval = setInterval(() => {
        if (isGenerating) {
            // If reliable detection is active, don't use fallback timeouts
            if (logFilePath || debugFileStates.size > 0 || codexSessionStates.size > 0) {
                return;
            }
            // For Codex or when no other detection is available, use shorter timeout
            if (currentSource === 'codex') {
                const timeSinceActivity = Date.now() - lastActivityTime;
                if (timeSinceActivity > 5000) {
                    log('Codex: No activity for 5s, triggering completion');
                    triggerCompletion();
                }
            }
        }
    }, 2000);
}
function markGenerating(sourceOverride) {
    if (!isGenerating && isEnabled()) {
        // Check cooldown to prevent rapid-fire detections (e.g., from VS Code extension Claude)
        const now = Date.now();
        if (now - lastCompletionTime < COMPLETION_COOLDOWN_MS) {
            // Still in cooldown, ignore this start signal
            return false;
        }
        const source = sourceOverride || resolveActiveSource();
        log(`Generation started (${source})`);
        isGenerating = true;
        lastActivityTime = Date.now();
        currentSource = source;
        updateStatusBar('generating');
        reportToHub(source, 'generating');
        return true;
    }
    return isGenerating;
}
function handleTerminalData(data, source) {
    if (!isEnabled())
        return;
    if (debugTerminalData()) {
        const snippet = normalizeTerminalText(data).replace(/\s+/g, ' ').slice(0, 200);
        log(`Terminal data (${source}): ${snippet}`);
    }
    if (source === 'claude-code') {
        const clean = normalizeTerminalText(data);
        claudeStreamBuffer += clean;
        if (claudeStreamBuffer.length > 8000) {
            claudeStreamBuffer = claudeStreamBuffer.slice(-4000);
        }
        processClaudeStream(claudeStreamBuffer);
        return;
    }
    // Codex fallback: any terminal output marks generating; inactivity or command end marks completion.
    markGenerating(source);
}
function processClaudeStream(buffer) {
    const outputRegex = new RegExp(claudeOutputPattern());
    const completeRegex = new RegExp(claudeCompletePattern());
    const lower = buffer.toLowerCase();
    if (lower.includes('ctrl-c') || lower.includes('interrupt') || lower.includes('^c')) {
        if (isGenerating) {
            log('Claude interrupt detected -> complete');
            claudeSawOutputLine = false;
            claudeAwaitingResponse = false;
            triggerCompletion();
            claudeStreamBuffer = '';
        }
        return;
    }
    const promptWithText = /❯\s+\S/.exec(buffer);
    if (promptWithText) {
        claudeLastPromptIndex = promptWithText.index;
        claudeAwaitingResponse = true;
    }
    const outputMatch = outputRegex.exec(buffer);
    if (outputMatch) {
        claudeLastOutputIndex = outputMatch.index;
        claudeSawOutputLine = true;
    }
    if (!isGenerating && claudeAwaitingResponse && claudeLastOutputIndex > claudeLastPromptIndex && claudeLastPromptIndex >= 0) {
        if (debugTerminalData()) {
            log('Claude output pattern matched -> generating');
        }
        markGenerating('claude-code');
    }
    if (isGenerating && claudeSawOutputLine) {
        const promptOnly = /❯\s*$/.exec(buffer);
        const shortcutsLine = /\?\s+for\s+shortcuts/i.test(buffer);
        if ((promptOnly && shortcutsLine) || completeRegex.test(buffer)) {
            if (debugTerminalData()) {
                log('Claude completion pattern matched -> complete');
            }
            claudeSawOutputLine = false;
            claudeAwaitingResponse = false;
            claudeLastPromptIndex = -1;
            claudeLastOutputIndex = -1;
            triggerCompletion();
            claudeStreamBuffer = '';
        }
    }
}
function scheduleCompletionCheck() {
    if (pendingCompletionTimeout) {
        clearTimeout(pendingCompletionTimeout);
    }
    pendingCompletionTimeout = setTimeout(() => {
        if (isGenerating) {
            triggerCompletion();
        }
    }, 300);
}
function triggerCompletion() {
    if (isGenerating && isEnabled()) {
        // Check cooldown to prevent rapid-fire notifications (e.g., from VS Code extension Claude)
        const now = Date.now();
        if (now - lastCompletionTime < COMPLETION_COOLDOWN_MS) {
            log('Completion ignored - cooldown active');
            isGenerating = false;
            updateStatusBar('idle');
            return;
        }
        lastCompletionTime = now;
        currentSource = resolveActiveSource();
        log('Generation complete');
        isGenerating = false;
        updateStatusBar('complete');
        if (!requireHubConnected()) {
            updateStatusBar('disconnected');
            return;
        }
        // Report to hub (this triggers the sound/alarm on the server)
        reportToHub(currentSource || 'claude-code', 'complete');
        // Show VS Code notification if enabled
        if (showVSCodeNotification()) {
            vscode.window.showInformationMessage(`${getSourceLabel(currentSource)} has finished generating`, 'Open Dashboard', 'Dismiss').then(selection => {
                log(`Notification button clicked: "${selection}"`);
                if (selection === 'Open Dashboard') {
                    openDashboard();
                }
                else if (selection === 'Dismiss') {
                    // Dismiss the persistent alarm on the server
                    dismissAlarm();
                }
            });
        }
        // Reset status after a delay
        setTimeout(() => {
            if (!isGenerating) {
                updateStatusBar('idle');
            }
        }, 5000);
    }
}
function stopGeneratingSilently(source) {
    if (!isGenerating)
        return;
    currentSource = source;
    isGenerating = false;
    updateStatusBar('idle');
    if (source === 'claude-code') {
        clearClaudeHistoryCompletionTimeout();
    }
    log('Generation cancelled');
}
function checkForCompletion() {
    // Check if enough time has passed since last activity
    const timeSinceActivity = Date.now() - lastActivityTime;
    if (timeSinceActivity > 2000) {
        triggerCompletion();
    }
}
function updateStatusBar(status) {
    if (!isEnabled()) {
        statusBarItem.text = '$(bell-slash) LLM Notify (off)';
        statusBarItem.tooltip = 'LLM Notify is disabled';
        statusBarItem.backgroundColor = undefined;
        statusBarItem.show();
        return;
    }
    switch (status) {
        case 'idle':
            statusBarItem.text = hubConnected ? '$(bell) LLM Notify' : '$(bell-slash) LLM Notify';
            statusBarItem.tooltip = hubConnected ? 'Connected to LLM Notify Hub' : 'Hub not connected (click to open dashboard)';
            statusBarItem.backgroundColor = undefined;
            break;
        case 'generating':
            statusBarItem.text = `$(sync~spin) ${getSourceLabel(currentSource)}...`;
            statusBarItem.tooltip = `${getSourceLabel(currentSource)} is generating...`;
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            break;
        case 'complete':
            statusBarItem.text = '$(check) Complete!';
            statusBarItem.tooltip = `${getSourceLabel(currentSource)} finished generating`;
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            break;
        case 'disconnected':
            statusBarItem.text = '$(bell-slash) LLM Notify';
            statusBarItem.tooltip = 'Not connected to hub';
            statusBarItem.backgroundColor = undefined;
            break;
    }
    statusBarItem.show();
}
function enqueueHubEvent(source, status, duration) {
    const now = Date.now();
    // Drop duplicates (same source + status) to avoid alarm storms on reconnect.
    for (let i = pendingHubEvents.length - 1; i >= 0; i--) {
        if (pendingHubEvents[i].source === source && pendingHubEvents[i].status === status) {
            pendingHubEvents.splice(i, 1);
            break;
        }
    }
    pendingHubEvents.push({ source, status, duration, ts: now });
    if (pendingHubEvents.length > MAX_PENDING_HUB_EVENTS) {
        pendingHubEvents = pendingHubEvents.slice(-MAX_PENDING_HUB_EVENTS);
    }
}
function requireHubConnected() {
    if (hubConnected)
        return true;
    const now = Date.now();
    if (now - lastHubRequiredNoticeAt > HUB_REQUIRED_NOTICE_COOLDOWN_MS) {
        lastHubRequiredNoticeAt = now;
        vscode.window.showInformationMessage('LLM Notify Hub is not running. Start the app to enable notifications.', 'Open Dashboard').then(selection => {
            if (selection === 'Open Dashboard') {
                openDashboard();
            }
        });
    }
    return false;
}
async function reportToHub(source, status, duration) {
    if (!isEnabled())
        return;
    const hubUrl = HUB_URL();
    const now = Date.now();
    if (!hubConnected || now < nextHubAttemptAt)
        return;
    const data = JSON.stringify({
        source: source,
        status: status,
        duration: duration,
        timestamp: Date.now()
    });
    const url = new URL('/api/event', hubUrl);
    const options = {
        hostname: url.hostname,
        port: url.port || 3847,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    };
    return new Promise((resolve) => {
        const req = http.request(options, (res) => {
            hubConnected = res.statusCode === 200;
            if (hubConnected) {
                hubBackoffMs = 0;
                nextHubAttemptAt = 0;
            }
            if (res.statusCode === 200) {
                log(`Reported to hub: ${status}`);
            }
            resolve();
        });
        req.on('error', (e) => {
            hubConnected = false;
            lastHubErrorAt = now;
            hubBackoffMs = Math.min(HUB_BACKOFF_MAX_MS, hubBackoffMs ? hubBackoffMs * 2 : 1000);
            nextHubAttemptAt = now + hubBackoffMs;
            if (now - lastHubErrorLogAt > HUB_ERROR_LOG_COOLDOWN_MS) {
                log(`Hub not available: ${e.message}`);
                lastHubErrorLogAt = now;
            }
            resolve();
        });
        req.setTimeout(2000, () => {
            req.destroy();
            hubConnected = false;
            lastHubErrorAt = now;
            hubBackoffMs = Math.min(HUB_BACKOFF_MAX_MS, hubBackoffMs ? hubBackoffMs * 2 : 1000);
            nextHubAttemptAt = now + hubBackoffMs;
            if (now - lastHubErrorLogAt > HUB_ERROR_LOG_COOLDOWN_MS) {
                log('Hub not available: timeout');
                lastHubErrorLogAt = now;
            }
            resolve();
        });
        req.write(data);
        req.end();
    });
}
async function checkHubConnection() {
    const hubUrl = HUB_URL();
    const url = new URL('/api/health', hubUrl);
    const options = {
        hostname: url.hostname,
        port: url.port || 3847,
        path: url.pathname,
        method: 'GET',
        timeout: 2000
    };
    return new Promise((resolve) => {
        const req = http.request(options, (res) => {
            hubConnected = res.statusCode === 200;
            if (!isGenerating) {
                updateStatusBar('idle');
            }
            if (hubConnected) {
                flushPendingHubEvents();
            }
            resolve();
        });
        req.on('error', () => {
            hubConnected = false;
            if (!isGenerating) {
                updateStatusBar('disconnected');
            }
            resolve();
        });
        req.setTimeout(2000, () => {
            req.destroy();
            hubConnected = false;
            resolve();
        });
        req.end();
    });
}
async function flushPendingHubEvents() {
    if (!hubConnected || pendingHubEvents.length === 0)
        return;
    if (Date.now() < nextHubAttemptAt)
        return;
    const queue = [...pendingHubEvents];
    pendingHubEvents = [];
    for (const evt of queue) {
        await reportToHub(evt.source, evt.status, evt.duration);
    }
}
// Dismiss the persistent alarm on the hub server
async function dismissAlarmCommand() {
    dismissAlarm();
    if (!isGenerating) {
        updateStatusBar('idle');
    }
}
function dismissAlarm() {
    const hubUrl = HUB_URL();
    const url = new URL('/api/dismiss', hubUrl);
    const options = {
        hostname: url.hostname,
        port: url.port || 3847,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': 0
        }
    };
    const req = http.request(options, (res) => {
        if (res.statusCode === 200) {
            log('Alarm dismissed');
        }
    });
    req.on('error', (e) => {
        log(`Failed to dismiss alarm: ${e.message}`);
    });
    req.setTimeout(2000, () => {
        req.destroy();
    });
    req.end();
}
async function testNotification() {
    log('Sending test notification');
    if (!requireHubConnected()) {
        return;
    }
    // Report to hub
    await reportToHub(resolveCurrentSource(), 'complete');
    // Show local notification
    vscode.window.showInformationMessage('LLM Notify: Test notification sent!', 'Open Dashboard').then(selection => {
        if (selection === 'Open Dashboard') {
            openDashboard();
        }
    });
}
function openDashboard() {
    const hubUrl = HUB_URL();
    vscode.env.openExternal(vscode.Uri.parse(hubUrl));
}
async function toggleEnabled() {
    const config = vscode.workspace.getConfiguration('llmNotify');
    const currentValue = config.get('enabled') ?? true;
    await config.update('enabled', !currentValue, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`LLM Notify: ${!currentValue ? 'Enabled' : 'Disabled'}`);
    updateStatusBar('idle');
}
function deactivate() {
    if (checkInterval) {
        clearInterval(checkInterval);
    }
    if (pendingCompletionTimeout) {
        clearTimeout(pendingCompletionTimeout);
    }
    if (logWatcher) {
        logWatcher.close();
    }
    if (logWatcherRetry) {
        clearTimeout(logWatcherRetry);
    }
    if (claudeSsePollInterval) {
        clearInterval(claudeSsePollInterval);
    }
    stopClaudeDebugWatcher();
    stopCodexSessionsWatcher();
    log('Extension deactivated');
}
function resolveCurrentSource() {
    if (lastTerminalSource && Date.now() - lastTerminalActivity < 60000) {
        return lastTerminalSource;
    }
    if (logFilePath) {
        return 'claude-code';
    }
    return detectCodex() ? 'codex' : 'claude-code';
}
function getSourceLabel(source) {
    return source === 'codex' ? 'Codex' : 'Claude Code';
}
function getExecutionSource(commandLine) {
    if (!commandLine)
        return null;
    const normalized = commandLine.toLowerCase();
    if (detectCodex() && (normalized.includes('codex') ||
        normalized.includes('openai') ||
        normalized.includes('chatgpt') ||
        normalized.includes('gpt'))) {
        return 'codex';
    }
    if (detectClaudeCode() && (normalized.includes('claude') ||
        normalized.includes('anthropic') ||
        normalized.includes('claude-code'))) {
        return 'claude-code';
    }
    return null;
}
function detectSourceFromData(data) {
    const clean = stripAnsi(data);
    const outputRegex = new RegExp(claudeOutputPattern());
    const promptRegex = new RegExp(claudePromptPattern());
    const completeRegex = new RegExp(claudeCompletePattern());
    if (outputRegex.test(clean) ||
        promptRegex.test(clean) ||
        completeRegex.test(clean) ||
        clean.toLowerCase().includes('claude code') ||
        clean.toLowerCase().includes('claude') ||
        clean.toLowerCase().includes('anthropic')) {
        return 'claude-code';
    }
    return null;
}
function log(message) {
    const line = `[LLM Notify] ${message}`;
    console.log(line);
    if (outputChannel) {
        outputChannel.appendLine(line);
    }
}
function stripAnsi(input) {
    return input.replace(/\u001b\[[0-9;]*m/g, '');
}
function normalizeTerminalText(input) {
    const noAnsi = stripAnsi(input);
    return noAnsi.replace(/[\x00-\x1F\x7F]/g, ' ');
}
//# sourceMappingURL=extension.js.map