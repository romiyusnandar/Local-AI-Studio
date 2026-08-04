// Rekam mikrofon dan encode langsung ke WAV PCM 16-bit di browser.
// whisper-server mengharapkan WAV mentah — MediaRecorder bawaan browser
// menghasilkan webm/opus, jadi kita tangkap sample PCM sendiri lewat
// Web Audio API dan tulis header WAV manual.

export class MicRecorder {
  constructor(onLevel) {
    this.onLevel = onLevel;
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.analyser = null;
    this.chunks = [];
    this.sampleRate = 16000;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.sampleRate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.source.connect(this.analyser);

    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.processor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(data));
      this._tickLevel();
    };
    this.source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
  }

  _tickLevel() {
    if (!this.onLevel || !this.analyser) return;
    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(buf);
    const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
    this.onLevel(Math.min(1, avg / 90));
  }

  stop() {
    if (this.processor) { this.processor.disconnect(); this.processor.onaudioprocess = null; }
    if (this.source) this.source.disconnect();
    if (this.analyser) this.analyser.disconnect();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    const sampleRate = this.sampleRate;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) { merged.set(c, off); off += c.length; }
    if (this.ctx) this.ctx.close();
    return encodeWav(merged, sampleRate);
  }
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}
