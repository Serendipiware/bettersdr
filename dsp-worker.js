import { parentPort } from "node:worker_threads";

const IQ_RATE = 2_400_000;
const AUDIO_RATE = 48_000;
const FFT_SIZE = 2048;
const FFT_INTERVAL_SAMPLES = Math.floor(IQ_RATE / 18);
const AUDIO_CHUNK_SAMPLES = 960;
const DEFAULT_CONFIG = { mode: "wbfm", bandwidth: 180_000, deemphasis: "50", squelch: 0, frequencyOffset: 0 };

const sessions = new Map();
let dcI = 0;
let dcQ = 0;
let samplesUntilFft = 0;
let fftWrite = 0;
let fftReady = false;
let spectrumFloor = -72;

const fftI = new Float64Array(FFT_SIZE);
const fftQ = new Float64Array(FFT_SIZE);
const windowI = new Float64Array(FFT_SIZE);
const windowQ = new Float64Array(FFT_SIZE);
const hann = new Float64Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i += 1) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));

function makeSession(id, incoming = {}) {
  const session = { id, config: { ...DEFAULT_CONFIG, ...incoming } };
  resetSession(session);
  updateNco(session, session.config.frequencyOffset);
  return session;
}

function resetSession(session) {
  session.decimateI = 0;
  session.decimateQ = 0;
  session.decimateCount = 0;
  session.previousI = 1;
  session.previousQ = 0;
  session.audioAccumulator = 0;
  session.audioDecimateCount = 0;
  session.audioResamplePhase = 0;
  session.audioDc = 0;
  session.audioLastInput = 0;
  session.audioLastOutput = 0;
  session.deemphasis = 0;
  session.signalLevel = 0;
  session.cwPhase = 0;
  session.channelI1 = 0;
  session.channelQ1 = 0;
  session.channelI2 = 0;
  session.channelQ2 = 0;
  session.channelAlpha = 1;
  session.channelFilterRate = 0;
  session.channelFilterBandwidth = 0;
  session.ncoCos = 1;
  session.ncoSin = 0;
  session.ncoStepCos = 1;
  session.ncoStepSin = 0;
  session.ncoOffset = 0;
  session.ncoSamples = 0;
  session.audioSamples = [];
}

function resetSharedDsp() {
  dcI = 0;
  dcQ = 0;
  samplesUntilFft = 0;
  fftWrite = 0;
  fftReady = false;
  for (const session of sessions.values()) {
    resetSession(session);
    updateNco(session, session.config.frequencyOffset);
  }
}

function updateNco(session, offset) {
  session.ncoOffset = Number(offset) || 0;
  const angle = (2 * Math.PI * session.ncoOffset) / IQ_RATE;
  session.ncoStepCos = Math.cos(angle);
  session.ncoStepSin = Math.sin(angle);
}

function fft(real, imag) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const stepR = Math.cos(angle);
    const stepI = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let wr = 1;
      let wi = 0;
      const half = length >> 1;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const tr = wr * real[odd] - wi * imag[odd];
        const ti = wr * imag[odd] + wi * real[odd];
        const er = real[even];
        const ei = imag[even];
        real[even] = er + tr; imag[even] = ei + ti;
        real[odd] = er - tr; imag[odd] = ei - ti;
        const nextWr = wr * stepR - wi * stepI;
        wi = wr * stepI + wi * stepR;
        wr = nextWr;
      }
    }
  }
}

function emitSpectrum() {
  for (let i = 0; i < FFT_SIZE; i += 1) {
    const source = (fftWrite + i) % FFT_SIZE;
    windowI[i] = fftI[source] * hann[i];
    windowQ[i] = fftQ[source] * hann[i];
  }
  fft(windowI, windowQ);
  const db = new Float64Array(FFT_SIZE);
  const sortable = new Float64Array(FFT_SIZE);
  const normalizer = FFT_SIZE * FFT_SIZE;
  for (let i = 0; i < FFT_SIZE; i += 1) {
    const source = (i + FFT_SIZE / 2) % FFT_SIZE;
    const power = (windowI[source] ** 2 + windowQ[source] ** 2) / normalizer;
    const value = 10 * Math.log10(power + 1e-14);
    db[i] = value;
    sortable[i] = value;
  }
  sortable.sort();
  const measuredFloor = sortable[Math.floor(FFT_SIZE * 0.28)];
  spectrumFloor += (measuredFloor - spectrumFloor) * 0.08;
  const low = spectrumFloor + 2;
  const high = low + 42;
  const bins = new Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i += 1) bins[i] = Math.max(0, Math.min(255, Math.round(((db[i] - low) / (high - low)) * 255)));
  parentPort.postMessage({ type: "spectrum", bins, floor: Math.round(spectrumFloor), sampleRate: IQ_RATE });
}

function pushAudio(session, value) {
  session.audioLastOutput = value - session.audioLastInput + 0.995 * session.audioLastOutput;
  session.audioLastInput = value;
  let output = session.audioLastOutput;
  if (session.config.squelch > 0) {
    const threshold = 0.0025 * (1 + session.config.squelch / 7);
    if (session.signalLevel < threshold) output = 0;
  }
  const gain = session.config.mode === "am" ? 3.2 : session.config.mode === "wbfm" ? 0.88 : 1.15;
  session.audioSamples.push(Math.max(-32767, Math.min(32767, Math.round(output * gain * 32767))));
  if (session.audioSamples.length < AUDIO_CHUNK_SAMPLES) return;
  const pcm = new Int16Array(session.audioSamples);
  session.audioSamples = [];
  parentPort.postMessage({ type: "audio", sessionId: session.id, data: pcm.buffer }, [pcm.buffer]);
}

function resampleAudio(session, value, inputRate) {
  session.audioAccumulator += value;
  session.audioDecimateCount += 1;
  session.audioResamplePhase += AUDIO_RATE;
  if (session.audioResamplePhase < inputRate) return;
  session.audioResamplePhase -= inputRate;
  pushAudio(session, session.audioAccumulator / session.audioDecimateCount);
  session.audioAccumulator = 0;
  session.audioDecimateCount = 0;
}

function demodulate(session, i, q, rate) {
  const config = session.config;
  if (session.channelFilterRate !== rate || session.channelFilterBandwidth !== config.bandwidth) {
    const cutoff = Math.min(rate * 0.45, Math.max(50, Number(config.bandwidth) / 2));
    session.channelAlpha = 1 - Math.exp((-2 * Math.PI * cutoff) / rate);
    session.channelFilterRate = rate;
    session.channelFilterBandwidth = config.bandwidth;
  }
  session.channelI1 += session.channelAlpha * (i - session.channelI1);
  session.channelQ1 += session.channelAlpha * (q - session.channelQ1);
  session.channelI2 += session.channelAlpha * (session.channelI1 - session.channelI2);
  session.channelQ2 += session.channelAlpha * (session.channelQ1 - session.channelQ2);
  i = session.channelI2;
  q = session.channelQ2;
  const magnitude = Math.hypot(i, q);
  session.signalLevel += (magnitude - session.signalLevel) * 0.004;
  let audio = 0;
  if (config.mode === "wbfm" || config.mode === "fm") {
    const cross = session.previousI * q - session.previousQ * i;
    const dot = session.previousI * i + session.previousQ * q;
    const phase = Math.atan2(cross, dot);
    session.previousI = i;
    session.previousQ = q;
    const deviation = config.mode === "wbfm" ? 75_000 : 5_000;
    audio = phase / (2 * Math.PI * deviation / rate);
  } else if (config.mode === "am") {
    session.audioDc += (magnitude - session.audioDc) * 0.0015;
    audio = magnitude - session.audioDc;
  } else if (config.mode === "cw") {
    session.cwPhase += 2 * Math.PI * 700 / rate;
    if (session.cwPhase > 2 * Math.PI) session.cwPhase -= 2 * Math.PI;
    audio = i * Math.cos(session.cwPhase) + q * Math.sin(session.cwPhase);
  } else if (config.mode === "dsb") {
    audio = i;
  } else {
    audio = 0;
  }

  if (config.mode === "wbfm" && config.deemphasis !== "off") {
    const timeConstant = Number(config.deemphasis) * 1e-6;
    const alpha = 1 - Math.exp(-1 / (rate * timeConstant));
    session.deemphasis += alpha * (audio - session.deemphasis);
    audio = session.deemphasis;
  }
  resampleAudio(session, audio, rate);
}

function processSessionSample(session, i, q) {
  let demodI = i;
  let demodQ = q;
  if (session.ncoOffset !== 0) {
    demodI = i * session.ncoCos + q * session.ncoSin;
    demodQ = q * session.ncoCos - i * session.ncoSin;
    const nextCos = session.ncoCos * session.ncoStepCos - session.ncoSin * session.ncoStepSin;
    session.ncoSin = session.ncoSin * session.ncoStepCos + session.ncoCos * session.ncoStepSin;
    session.ncoCos = nextCos;
    session.ncoSamples += 1;
    if ((session.ncoSamples & 4095) === 0) {
      const magnitude = Math.hypot(session.ncoCos, session.ncoSin) || 1;
      session.ncoCos /= magnitude;
      session.ncoSin /= magnitude;
    }
  }

  const decimation = session.config.mode === "wbfm" ? 8 : 25;
  const intermediateRate = IQ_RATE / decimation;
  session.decimateI += demodI;
  session.decimateQ += demodQ;
  session.decimateCount += 1;
  if (session.decimateCount === decimation) {
    demodulate(session, session.decimateI / decimation, session.decimateQ / decimation, intermediateRate);
    session.decimateI = 0;
    session.decimateQ = 0;
    session.decimateCount = 0;
  }
}

function processIq(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  for (let p = 0; p + 1 < bytes.length; p += 2) {
    const rawI = (bytes[p] - 127.5) / 128;
    const rawQ = (bytes[p + 1] - 127.5) / 128;
    dcI += (rawI - dcI) * 0.00015;
    dcQ += (rawQ - dcQ) * 0.00015;
    const i = rawI - dcI;
    const q = rawQ - dcQ;

    fftI[fftWrite] = i;
    fftQ[fftWrite] = q;
    fftWrite = (fftWrite + 1) % FFT_SIZE;
    if (fftWrite === 0) fftReady = true;
    samplesUntilFft -= 1;
    if (fftReady && samplesUntilFft <= 0) {
      emitSpectrum();
      samplesUntilFft = FFT_INTERVAL_SAMPLES;
    }

    for (const session of sessions.values()) processSessionSample(session, i, q);
  }
}

parentPort.on("message", (message) => {
  if (message.type === "session-config") {
    let session = sessions.get(message.sessionId);
    if (!session) {
      session = makeSession(message.sessionId, message.config);
      sessions.set(message.sessionId, session);
      return;
    }
    const modeChanged = message.config.mode !== session.config.mode;
    session.config = { ...session.config, ...message.config };
    if (modeChanged) resetSession(session);
    updateNco(session, session.config.frequencyOffset);
  }
  if (message.type === "session-remove") sessions.delete(message.sessionId);
  if (message.type === "reset") resetSharedDsp();
  if (message.type === "iq") processIq(message.data);
});
