import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 18787;
const URL = `ws://127.0.0.1:${PORT}/ws`;

class TestClient {
  constructor(origin = `http://127.0.0.1:${PORT}`, headers = {}) {
    this.socket = new WebSocket(URL, { headers: { ...headers, Origin: origin } });
    this.messages = [];
    this.binaryFrames = 0;
    this.waiters = [];
    this.socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.binaryFrames += 1;
        this.flush();
        return;
      }
      const message = JSON.parse(data.toString());
      if (message.type === "spectrum") return;
      this.messages.push(message);
      this.flush();
    });
  }

  flush() {
    for (const waiter of [...this.waiters]) {
      const value = waiter.read();
      if (value === undefined) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(value);
    }
  }

  waitFor(predicate, timeout = 10000) {
    const read = () => {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      return undefined;
    };
    const existing = read();
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { read, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        const queued = this.messages.slice(-8).map((message) => ({
          type: message.type,
          state: message.state,
          frequency: message.config?.frequency,
          centerFrequency: message.centerFrequency,
        }));
        reject(new Error(`timed out waiting for websocket state; queued messages: ${JSON.stringify(queued)}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  waitForAudio(timeout = 5000) {
    const startingCount = this.binaryFrames;
    return new Promise((resolve, reject) => {
      const waiter = {
        read: () => this.binaryFrames > startingCount ? this.binaryFrames : undefined,
        resolve,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error("timed out waiting for private audio"));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  send(type, extra = {}) {
    this.socket.send(JSON.stringify({ type, ...extra }));
  }

  close() {
    this.socket.close();
  }
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 5000);
    child.stdout.on("data", (chunk) => {
      if (!chunk.toString().includes("BetterSDR is ready")) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", (code) => reject(new Error(`server exited early with ${code}`)));
  });
}

function expectOriginRejected(origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(URL, { headers: { Origin: origin } });
    socket.once("open", () => reject(new Error("unexpectedly accepted a cross-origin websocket")));
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode;
      response.resume();
      status === 403 ? resolve() : reject(new Error(`expected 403, received ${status}`));
    });
    socket.once("error", () => {});
  });
}

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PATH: `${join(ROOT, "test", "bin")}:${process.env.PATH}`,
    RTL_SDR_COMMAND: join(ROOT, "test", "bin", "rtl_sdr"),
    RTL_BIAST_COMMAND: "/usr/bin/true",
    HOST: "127.0.0.1",
    PORT: String(PORT),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let first;
let second;
let remote;
let third;
try {
  await waitForServer(server);
  await expectOriginRejected("https://evil.example");
  remote = new TestClient("https://demo.ngrok-free.app", { Host: "demo.ngrok-free.app", "X-Forwarded-Proto": "https" });
  const remoteInitial = await remote.waitFor((message) => message.type === "state");
  assert.equal(remoteInitial.operator, false);
  assert.equal(remoteInitial.deviceControlsLocked, true);
  remote.send("update", { config: { ...remoteInitial.config, biasTee: true, gain: 30 } });
  const remoteHardwareRejected = await remote.waitFor((message) => message.type === "state" && Boolean(message.error));
  assert.equal(remoteHardwareRejected.config.biasTee, false);
  assert.equal(remoteHardwareRejected.config.gain, "auto");
  remote.close();

  first = new TestClient();
  second = new TestClient();
  const firstInitial = await first.waitFor((message) => message.type === "state");
  const secondInitial = await second.waitFor((message) => message.type === "state");
  assert.notEqual(firstInitial.sessionId, secondInitial.sessionId);
  assert.equal(firstInitial.operator, true);

  first.send("start", { config: { frequency: 100_700_000, mode: "wbfm", bandwidth: 180_000 } });
  const firstPlaying = await first.waitFor((message) => message.type === "state" && message.state === "playing");
  assert.equal(firstPlaying.running, true);

  second.send("start", { config: { frequency: 100_900_000, mode: "fm", bandwidth: 12_500 } });
  const secondPlaying = await second.waitFor((message) => message.type === "state" && message.state === "playing" && message.running);
  assert.equal(secondPlaying.config.frequency, 100_900_000);
  await Promise.all([first.waitForAudio(), second.waitForAudio()]);

  third = new TestClient();
  const thirdInitial = await third.waitFor((message) => message.type === "state");
  third.send("start", { config: { ...thirdInitial.config, frequency: 100_800_000 } });
  const thirdRejected = await third.waitFor((message) => message.type === "state" && message.state === "error");
  assert.match(thirdRejected.error, /2 active listeners/);
  third.close();

  first.send("update", { config: { ...firstPlaying.config, frequency: 110_000_000, gain: 30 } });
  const rejectedSharedChange = await first.waitFor((message) => message.type === "state" && Boolean(message.error));
  assert.equal(rejectedSharedChange.config.frequency, 100_700_000);
  assert.equal(rejectedSharedChange.config.gain, "auto");
  assert.equal(rejectedSharedChange.running, true);

  first.send("update", { config: { ...rejectedSharedChange.config, frequency: 100_800_000 } });
  const firstUpdated = await first.waitFor((message) => message.type === "state" && message.config?.frequency === 100_800_000);
  assert.equal(firstUpdated.running, true);
  second.send("get-state");
  const secondUnchanged = await second.waitFor((message) => message.type === "state" && message.config?.frequency === 100_900_000);
  assert.equal(secondUnchanged.running, true);

  first.send("stop");
  const firstStopped = await first.waitFor((message) => message.type === "state" && !message.running);
  assert.equal(firstStopped.state, "stopped");
  second.send("get-state");
  const secondStillPlaying = await second.waitFor((message) => message.type === "state" && message.running && message.state === "playing");
  assert.equal(secondStillPlaying.config.frequency, 100_900_000);

  second.send("stop");
  await second.waitFor((message) => message.type === "state" && !message.running);
  const status = await fetch(`http://127.0.0.1:${PORT}/api/status`).then((response) => response.json());
  assert.equal(status.activeListeners, 0);
  console.log("private multi-client session test passed");
} finally {
  first?.close();
  second?.close();
  remote?.close();
  third?.close();
  server.kill("SIGTERM");
}
