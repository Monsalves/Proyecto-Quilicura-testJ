import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitFor(check, message, attempts = 60, intervalMs = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch {
    }
    await delay(intervalMs);
  }
  throw new Error(message);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`request failed ${response.status}: ${url}`);
  }
  return response.json();
}

export async function startChrome({
  port = 9222,
  width = 1440,
  height = 960
} = {}) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'quilicura-chrome-'));
  const child = spawn('/usr/bin/google-chrome', [
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-crashpad',
    '--disable-crashpad-for-testing',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank'
  ], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const version = await waitFor(
    () => fetchJson(`http://127.0.0.1:${port}/json/version`),
    `chrome remote debugging did not become ready: ${stderr || 'no stderr'}`
  );

  return {
    port,
    child,
    userDataDir,
    websocketUrl: version.webSocketDebuggerUrl,
    stderrRef: () => stderr
  };
}

export async function stopChrome(instance) {
  if (!instance) {
    return;
  }
  instance.child.kill('SIGTERM');
  await delay(250);
  await rm(instance.userDataDir, { recursive: true, force: true });
}

export class BrowserSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
    this.events = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.wsUrl);
    this.socket.addEventListener('message', (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.id) {
        const pending = this.pending.get(payload.id);
        if (!pending) {
          return;
        }
        this.pending.delete(payload.id);
        if (payload.error) {
          pending.reject(new Error(payload.error.message || 'cdp error'));
          return;
        }
        pending.resolve(payload.result);
        return;
      }
      if (payload.sessionId && payload.method) {
        const key = `${payload.sessionId}:${payload.method}`;
        const handlers = this.events.get(key) || [];
        handlers.forEach((handler) => handler(payload.params || {}));
      }
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId;
    this.nextId += 1;
    const envelope = { id, method, params };
    if (sessionId) {
      envelope.sessionId = sessionId;
    }
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify(envelope));
    return promise;
  }

  on(sessionId, method, handler) {
    const key = `${sessionId}:${method}`;
    const handlers = this.events.get(key) || [];
    handlers.push(handler);
    this.events.set(key, handlers);
  }

  async newPage() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const attached = await this.send('Target.attachToTarget', {
      targetId,
      flatten: true
    });
    const sessionId = attached.sessionId;
    this.sessions.set(targetId, sessionId);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Network.enable', {}, sessionId);
    return sessionId;
  }

  async close() {
    if (!this.socket) {
      return;
    }
    this.socket.close();
    await delay(100);
  }
}

export async function navigate(browser, sessionId, url) {
  let loaded = false;
  browser.on(sessionId, 'Page.loadEventFired', () => {
    loaded = true;
  });
  await browser.send('Page.navigate', { url }, sessionId);
  await waitFor(() => loaded, `page did not load: ${url}`);
}

export async function evaluate(browser, sessionId, expression) {
  const result = await browser.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);
  return result.result?.value;
}

export async function waitForFunction(browser, sessionId, expression, message, attempts = 80) {
  return waitFor(async () => {
    const value = await evaluate(browser, sessionId, expression);
    return value ? value : false;
  }, message, attempts, 200);
}

export async function setViewport(browser, sessionId, width, height, mobile = false) {
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile
  }, sessionId);
}

export async function captureScreenshot(browser, sessionId, targetPath) {
  const screenshot = await browser.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true
  }, sessionId);
  await mkdir(join(targetPath, '..'), { recursive: true });
  await writeFile(targetPath, Buffer.from(screenshot.data, 'base64'));
}

export { assert, delay, waitFor };
