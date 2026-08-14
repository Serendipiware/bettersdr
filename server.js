import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1";
const RTL_SDR_COMMAND = process.env.RTL_SDR_COMMAND || "rtl_sdr";
const RTL_BIAST_COMMAND = process.env.RTL_BIAST_COMMAND || "rtl_biast";
const AUDIO_RATE = 48_000;
const IQ_RATE = 2_400_000;
const MAX_SESSIONS = Math.max(1, Math.min(8, Number(process.env.MAX_SESSIONS) || 2));
const MAX_CONNECTIONS = Math.max(MAX_SESSIONS, Math.min(64, Number(process.env.MAX_CONNECTIONS) || 16));
const EXTRA_ALLOWED_ORIGINS = new Set(String(process.env.ALLOWED_ORIGINS || "").split(",").map((value) => normalizeOrigin(value.trim())).filter(Boolean));
// these settings belong to the physical dongle so listeners cannot own them separately
const HARDWARE_KEYS = ["gain", "ppm", "biasTee", "directSampling", "device"];
const commandCache = new Map();

const DEFAULTS = Object.freeze({
  frequency: 100_700_000,
  mode: "wbfm",
  bandwidth: 180_000,
  deemphasis: "50",
  gain: "auto",
  squelch: 0,
  ppm: 0,
  biasTee: false,
  directSampling: "off",
  device: "0",
});

const MODE_OPTIONS = {
  wbfm: { minBandwidth: 50_000, maxBandwidth: 250_000, defaultBandwidth: 180_000 },
  fm: { minBandwidth: 1_000, maxBandwidth: 60_000, defaultBandwidth: 12_500 },
  am: { minBandwidth: 200, maxBandwidth: 50_000, defaultBandwidth: 10_000 },
  dsb: { minBandwidth: 200, maxBandwidth: 50_000, defaultBandwidth: 10_000 },
  cw: { minBandwidth: 50, maxBandwidth: 10_000, defaultBandwidth: 500 },
};

function normalizeOrigin(value) {
  if (!value) return null;
  try { return new URL(value).origin.toLowerCase(); }
  catch { return null; }
}

function requestOrigin(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const protocol = forwardedProto === "https" || request.socket.encrypted ? "https" : "http";
  const host = String(request.headers.host || "").trim();
  return normalizeOrigin(host ? `${protocol}://${host}` : "");
}

function isAllowedWebSocketOrigin(request) {
  // only accept browsers that opened bettersdr itself or an origin the owner allowed
  const origin = normalizeOrigin(request.headers.origin);
  return Boolean(origin && (origin === requestOrigin(request) || EXTRA_ALLOWED_ORIGINS.has(origin)));
}

function isLocalOperatorOrigin(request) {
  const origin = normalizeOrigin(request.headers.origin);
  if (!origin) return false;
  const hostname = new URL(origin).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeConfig(input = {}) {
  const mode = Object.hasOwn(MODE_OPTIONS, input.mode) ? input.mode : DEFAULTS.mode;
  const modeOptions = MODE_OPTIONS[mode];
  const rawGain = input.gain === "auto" ? "auto" : Number(input.gain);
  const rawBandwidth = Number(input.bandwidth);
  return {
    frequency: Math.round(clamp(Number(input.frequency) || DEFAULTS.frequency, 100_000, 1_766_000_000)),
    mode,
    bandwidth: Math.round(Number.isFinite(rawBandwidth)
      ? clamp(rawBandwidth, modeOptions.minBandwidth, modeOptions.maxBandwidth)
      : modeOptions.defaultBandwidth),
    deemphasis: ["off", "50", "75"].includes(String(input.deemphasis)) ? String(input.deemphasis) : DEFAULTS.deemphasis,
    gain: rawGain === "auto" || !Number.isFinite(rawGain) ? "auto" : Math.round(clamp(rawGain, 0, 49.6) * 10) / 10,
    squelch: Math.round(clamp(Number(input.squelch) || 0, 0, 100)),
    ppm: Math.round(clamp(Number(input.ppm) || 0, -250, 250)),
    biasTee: Boolean(input.biasTee),
    directSampling: ["off", "i", "q"].includes(input.directSampling) ? input.directSampling : "off",
    device: String(input.device ?? "0").slice(0, 64),
  };
}

function commandExists(command) {
  const cached = commandCache.get(command);
  if (cached && Date.now() - cached.checkedAt < 30_000) return Promise.resolve(cached.available);
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/env", ["which", command], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => {
      const available = code === 0;
      commandCache.set(command, { available, checkedAt: Date.now() });
      resolve(available);
    });
  });
}

class ReceiverSession {
  constructor(socket, frequency, operator) {
    this.id = randomUUID();
    this.socket = socket;
    this.config = sanitizeConfig({ ...DEFAULTS, frequency });
    this.running = false;
    this.state = "stopped";
    this.lastError = null;
    this.operator = operator;
    this.closed = false;
  }

  send(payload) {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 2 * 1024 * 1024) return;
    if (Buffer.isBuffer(payload)) this.socket.send(payload, { binary: true });
    else this.socket.send(JSON.stringify(payload));
  }
}

class RadioEngine {
  constructor() {
    this.sessions = new Map();
    this.hardwareConfig = { ...DEFAULTS };
    this.centerFrequency = DEFAULTS.frequency;
    this.process = null;
    this.worker = null;
    this.hardwareState = "stopped";
    this.hardwareError = null;
    this.restartTimer = null;
    this.pendingHardwareRestart = false;
    this.operation = Promise.resolve();
    this.retryCount = 0;
  }

  activeSessions() {
    return [...this.sessions.values()].filter((session) => session.running);
  }

  captureBounds() {
    // keep a little space away from the noisy edges of the captured iq slice
    return {
      min: Math.max(100_000, Math.round(this.centerFrequency - IQ_RATE * 0.44)),
      max: Math.min(1_766_000_000, Math.round(this.centerFrequency + IQ_RATE * 0.44)),
    };
  }

  sessionFitsCapture(config) {
    const usableHalfWidth = IQ_RATE * 0.44 - Math.max(1_000, config.bandwidth / 2);
    return Math.abs(config.frequency - this.centerFrequency) <= usableHalfWidth;
  }

  captureCenterFor(config, requestedCenter, pageDirection = 0) {
    const guard = Math.max(1_000, config.bandwidth / 2);
    const usableHalfWidth = Math.max(0, IQ_RATE * 0.44 - guard);
    const requested = requestedCenter === null || requestedCenter === undefined
      ? Number.NaN
      : Number(requestedCenter);
    const desired = Number.isFinite(requested)
      ? requested
      : config.frequency + pageDirection * usableHalfWidth;
    return Math.round(clamp(
      clamp(desired, config.frequency - usableHalfWidth, config.frequency + usableHalfWidth),
      100_000,
      1_766_000_000,
    ));
  }

  snapshot(session) {
    const activeCount = this.activeSessions().length;
    const bounds = this.captureBounds();
    const state = session.running ? this.hardwareState : session.state;
    return {
      type: "state",
      sessionId: session.id,
      state,
      running: session.running,
      config: session.config,
      centerFrequency: this.process || this.worker ? this.centerFrequency : session.config.frequency,
      captureMin: bounds.min,
      captureMax: bounds.max,
      activeListeners: activeCount,
      canRetuneCapture: session.running && activeCount === 1,
      deviceControlsLocked: !session.operator || (activeCount > 0 && !(session.running && activeCount === 1)),
      operator: session.operator,
      error: session.lastError || (session.running ? this.hardwareError : null),
      audioRate: AUDIO_RATE,
      iqRate: IQ_RATE,
    };
  }

  sendState(session) {
    session.send(this.snapshot(session));
  }

  emitActiveStates() {
    for (const session of this.sessions.values()) this.sendState(session);
  }

  register(socket, operator) {
    // every browser gets private tuning and audio state even though the iq source is shared
    const initialFrequency = this.activeSessions().length ? this.centerFrequency : DEFAULTS.frequency;
    const session = new ReceiverSession(socket, initialFrequency, operator);
    this.sessions.set(session.id, session);
    this.sendState(session);
    this.emitActiveStates();
    return session;
  }

  workerConfig(session) {
    return {
      mode: session.config.mode,
      bandwidth: session.config.bandwidth,
      deemphasis: session.config.deemphasis,
      squelch: session.config.squelch,
      frequencyOffset: session.config.frequency - this.centerFrequency,
    };
  }

  postSessionConfig(session) {
    this.worker?.postMessage({ type: "session-config", sessionId: session.id, config: this.workerConfig(session) });
  }

  copyHardwareConfig(target) {
    for (const key of HARDWARE_KEYS) target[key] = this.hardwareConfig[key];
  }

  async startSession(session, input) {
    if (session.closed || session.running) return;
    const active = this.activeSessions();
    if (active.length >= MAX_SESSIONS) {
      session.state = "error";
      session.lastError = `this receiver already has ${MAX_SESSIONS} active listeners. try again when a slot is free.`;
      this.sendState(session);
      return;
    }
    const rtlSdrAvailable = await commandExists(RTL_SDR_COMMAND);
    if (session.closed) return;
    if (!rtlSdrAvailable) {
      session.state = "missing-tools";
      session.lastError = "rtl_sdr is not installed. Install the RTL-SDR Blog V4 drivers, then restart BetterSDR.";
      this.sendState(session);
      return;
    }

    const next = sanitizeConfig({ ...session.config, ...input });
    if (!session.operator) this.copyHardwareConfig(next);
    if (active.length && !this.sessionFitsCapture(next)) {
      const bounds = this.captureBounds();
      session.state = "error";
      session.lastError = `that frequency is outside the shared ${IQ_RATE / 1_000_000} MHz capture window (${(bounds.min / 1e6).toFixed(3)}–${(bounds.max / 1e6).toFixed(3)} MHz).`;
      this.sendState(session);
      return;
    }

    session.config = next;
    session.lastError = null;
    session.running = true;
    session.state = this.hardwareState === "playing" ? "playing" : "starting";
    if (!active.length) {
      this.centerFrequency = session.config.frequency;
      if (session.operator) this.hardwareConfig = { ...session.config };
      this.hardwareState = "starting";
      this.hardwareError = null;
      this.emitActiveStates();
      await this.enqueue(() => this.restartNow());
      return;
    }

    this.copyHardwareConfig(session.config);
    this.postSessionConfig(session);
    this.emitActiveStates();
  }

  updateSession(session, input, requestedCenter) {
    if (session.closed) return;
    const previous = session.config;
    const next = sanitizeConfig({ ...previous, ...input });
    session.lastError = null;
    const hardwareChanged = HARDWARE_KEYS.some((key) => next[key] !== previous[key]);
    if (hardwareChanged && !session.operator) {
      this.copyHardwareConfig(next);
      session.lastError = "device-level controls are available only from BetterSDR on the receiver computer.";
    }
    if (!session.running) {
      session.config = next;
      this.sendState(session);
      return;
    }

    const activeCount = this.activeSessions().length;
    if (hardwareChanged && session.operator && activeCount > 1) {
      this.copyHardwareConfig(next);
      session.lastError = "device-level controls are locked while other listeners are active; your private tuning and audio controls still work.";
    }

    const outsideCapture = !this.sessionFitsCapture(next);
    if (outsideCapture && activeCount > 1) {
      // moving the dongle here would interrupt every other listener
      next.frequency = previous.frequency;
      session.lastError = "that station is outside the current 2.4 MHz capture window while other listeners are active.";
    }

    session.config = next;
    if (hardwareChanged && session.operator && activeCount === 1) this.hardwareConfig = { ...next };

    const pageDirection = Math.sign(next.frequency - this.centerFrequency) || 1;
    const nextCenter = this.captureCenterFor(next, requestedCenter, pageDirection);
    const hasRequestedCenter = requestedCenter !== null && requestedCenter !== undefined
      && Number.isFinite(Number(requestedCenter));
    const shouldMoveCapture = hasRequestedCenter
      && Math.abs(nextCenter - this.centerFrequency) >= 1_000;
    if ((outsideCapture || shouldMoveCapture) && activeCount === 1) {
      this.scheduleRestart(420, pageDirection, nextCenter);
    } else if (hardwareChanged && session.operator && activeCount === 1) {
      this.scheduleRestart(220);
    } else {
      if (this.restartTimer && !this.pendingHardwareRestart) this.clearRestart();
      this.postSessionConfig(session);
    }
    this.sendState(session);
  }

  async stopSession(session, { disconnect = false } = {}) {
    if (session.closed && !disconnect) return;
    const wasRunning = session.running;
    session.running = false;
    session.state = "stopped";
    session.lastError = null;
    this.worker?.postMessage({ type: "session-remove", sessionId: session.id });
    if (!disconnect) this.sendState(session);
    if (wasRunning && this.activeSessions().length === 0) {
      this.clearRestart();
      await this.enqueue(() => this.stopProcess());
      try { await this.setBiasTee(false); } catch {}
      this.hardwareState = "stopped";
      this.hardwareError = null;
    }
    this.emitActiveStates();
  }

  async removeSession(session) {
    if (session.closed) return;
    session.closed = true;
    await this.stopSession(session, { disconnect: true });
    this.sessions.delete(session.id);
    this.emitActiveStates();
  }

  buildArgs() {
    const cfg = this.hardwareConfig;
    const args = [
      "-d", cfg.device,
      "-f", String(this.centerFrequency),
      "-s", String(IQ_RATE),
      "-p", String(cfg.ppm),
      "-b", "32768",
    ];
    if (cfg.gain !== "auto") args.push("-g", String(cfg.gain));
    if (cfg.directSampling === "i") args.push("-D", "1");
    if (cfg.directSampling === "q") args.push("-D", "2");
    args.push("-");
    return args;
  }

  launch() {
    this.clearRestart();
    if (!this.activeSessions().length) return;

    this.hardwareState = "starting";
    this.emitActiveStates();
    const worker = new Worker(new URL("./dsp-worker.js", import.meta.url), { type: "module" });
    this.worker = worker;
    for (const session of this.activeSessions()) this.postSessionConfig(session);
    const child = spawn(RTL_SDR_COMMAND, this.buildArgs(), { stdio: ["ignore", "pipe", "pipe"] });
    this.process = child;
    const centerFrequency = this.centerFrequency;
    let stderr = "";
    let heardIq = false;

    worker.on("message", (message) => {
      // an old worker may still finish a callback after a fast retune
      if (this.worker !== worker) return;
      if (message.type === "audio") {
        const session = this.sessions.get(message.sessionId);
        if (!session?.running) return;
        const chunk = Buffer.from(message.data);
        session.send(chunk);
      }
      if (message.type === "spectrum") {
        const payload = { ...message, centerFrequency };
        for (const session of this.activeSessions()) session.send(payload);
      }
    });
    worker.on("error", (error) => {
      if (this.worker !== worker) return;
      this.hardwareError = `receiver DSP stopped: ${error.message}`;
      child.kill("SIGTERM");
    });

    child.stdout.on("data", (chunk) => {
      // ignore data from a process that has already been replaced
      if (this.worker !== worker) return;
      if (!heardIq) {
        heardIq = true;
        this.retryCount = 0;
        this.hardwareState = "playing";
        this.hardwareError = null;
        this.emitActiveStates();
      }
      const iq = Uint8Array.from(chunk);
      worker.postMessage({ type: "iq", data: iq.buffer }, [iq.buffer]);
    });

    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });

    child.once("error", (error) => {
      if (this.process !== child) return;
      this.process = null;
      if (this.worker === worker) {
        this.worker = null;
        void worker.terminate();
      }
      this.hardwareState = "error";
      this.hardwareError = error.message;
      this.emitActiveStates();
    });

    child.once("exit", (code, signal) => {
      if (this.process !== child) return;
      this.process = null;
      if (this.worker === worker) {
        this.worker = null;
        void worker.terminate();
      }
      if (!this.activeSessions().length) {
        this.hardwareState = "stopped";
        this.emitActiveStates();
        return;
      }
      void this.handleUnexpectedExit(code, signal, stderr);
    });
  }

  async handleUnexpectedExit(code, signal, stderr) {
    const usefulError = stderr.split("\n").map((line) => line.trim()).filter(Boolean).slice(-3).join(" ");
    if (this.activeSessions().length && this.retryCount < 1) {
      this.retryCount += 1;
      this.hardwareState = "starting";
      this.hardwareError = "the receiver paused unexpectedly, retrying once…";
      this.emitActiveStates();
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (this.activeSessions().length) await this.enqueue(() => this.restartNow());
      return;
    }
    this.hardwareState = "error";
    this.hardwareError = usefulError || `rtl_sdr stopped (${signal || code || "unknown reason"}).`;
    for (const session of this.activeSessions()) {
      session.running = false;
      session.state = "error";
      session.lastError = this.hardwareError;
      this.sendState(session);
    }
  }

  clearRestart() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.pendingHardwareRestart = false;
  }

  scheduleRestart(delay, pageDirection = 0, requestedCenter = null) {
    // keep a following ui update from cancelling a retune that is already waiting
    this.pendingHardwareRestart = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      const active = this.activeSessions();
      if (active.length !== 1) {
        this.pendingHardwareRestart = false;
        return;
      }
      if (pageDirection) {
        const session = active[0];
        // place the next capture ahead or behind so navigation keeps its direction
        this.centerFrequency = this.captureCenterFor(session.config, requestedCenter, pageDirection);
      }
      this.pendingHardwareRestart = false;
      void this.enqueue(() => this.restartNow());
    }, delay);
  }

  enqueue(task) {
    // run hardware changes one at a time so stop and start calls never overlap
    this.operation = this.operation.then(task, task).catch((error) => {
      this.hardwareState = "error";
      this.hardwareError = error instanceof Error ? error.message : String(error);
      this.emitActiveStates();
    });
    return this.operation;
  }

  async restartNow() {
    await this.stopProcess();
    if (!this.activeSessions().length) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
    await this.setBiasTee(this.hardwareConfig.biasTee);
    if (this.activeSessions().length) this.launch();
  }

  async setBiasTee(enabled) {
    if (!(await commandExists(RTL_BIAST_COMMAND))) {
      if (enabled) throw new Error("rtl_biast is required to enable the bias tee with the I/Q receiver.");
      return;
    }
    await new Promise((resolve, reject) => {
      const child = spawn(RTL_BIAST_COMMAND, ["-d", this.hardwareConfig.device, "-b", enabled ? "1" : "0"], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1200); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `rtl_biast stopped with code ${code}`)));
    });
  }

  async stopProcess() {
    if (this.worker) {
      const worker = this.worker;
      this.worker = null;
      await worker.terminate();
    }
    if (!this.process) return;
    const child = this.process;
    this.process = null;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    // give rtl_sdr a chance to release usb cleanly before forcing it down
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 700))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 300))]);
    }
  }

  publicStatus() {
    return {
      type: "receiver",
      state: this.hardwareState,
      running: this.activeSessions().length > 0,
      activeListeners: this.activeSessions().length,
      maxSessions: MAX_SESSIONS,
      centerFrequency: this.centerFrequency,
      captureMin: this.captureBounds().min,
      captureMax: this.captureBounds().max,
      error: this.hardwareError,
      audioRate: AUDIO_RATE,
      iqRate: IQ_RATE,
    };
  }

  async shutdown() {
    this.clearRestart();
    for (const session of this.sessions.values()) {
      session.running = false;
    }
    await this.stopProcess();
    try { await this.setBiasTee(false); } catch {}
  }
}

const app = express();
app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  });
  next();
});
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

const server = createServer(app);
const radio = new RadioEngine();

app.get("/api/status", async (_request, response) => {
  response.json({
    ...radio.publicStatus(),
    tools: {
      rtlSdr: await commandExists(RTL_SDR_COMMAND),
      rtlTest: await commandExists("rtl_test"),
    },
  });
});

function rejectUpgrade(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
wss.on("error", (error) => {
  console.error(`BetterSDR WebSocket error: ${error.message}`);
});
wss.on("connection", (socket, request) => {
  const session = radio.register(socket, isLocalOperatorOrigin(request));
  let messageWindowStartedAt = Date.now();
  let messagesInWindow = 0;

  socket.on("message", async (data, isBinary) => {
    if (isBinary) return;
    const now = Date.now();
    if (now - messageWindowStartedAt >= 10_000) {
      messageWindowStartedAt = now;
      messagesInWindow = 0;
    }
    messagesInWindow += 1;
    if (messagesInWindow > 120) {
      socket.close(1008, "message rate exceeded");
      return;
    }
    let message;
    try { message = JSON.parse(data.toString()); }
    catch { return; }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (message.type === "start") await radio.startSession(session, message.config);
    if (message.type === "stop") await radio.stopSession(session);
    if (message.type === "update") radio.updateSession(session, message.config, message.captureCenter);
    if (message.type === "get-state") radio.sendState(session);
  });

  socket.once("close", () => { void radio.removeSession(session); });
  socket.once("error", () => { void radio.removeSession(session); });
});

server.on("upgrade", (request, socket, head) => {
  let pathname;
  try { pathname = new URL(request.url || "/", "http://bettersdr.local").pathname; }
  catch { return rejectUpgrade(socket, 400, "Bad Request"); }
  if (pathname !== "/ws") return rejectUpgrade(socket, 404, "Not Found");
  if (!isAllowedWebSocketOrigin(request)) return rejectUpgrade(socket, 403, "Forbidden");
  if (radio.sessions.size >= MAX_CONNECTIONS) return rejectUpgrade(socket, 503, "Service Unavailable");
  wss.handleUpgrade(request, socket, head, (webSocket) => wss.emit("connection", webSocket, request));
});

server.listen(PORT, HOST, () => {
  console.log(`\n  BetterSDR is ready at http://${HOST}:${PORT}\n`);
});

server.on("error", (error) => {
  console.error(`BetterSDR could not start: ${error.message}`);
  process.exitCode = 1;
});

async function shutdown() {
  await radio.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
