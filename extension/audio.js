class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.currentSource = null;
    this.currentIndex = -1;
    this.totalSentences = 0;
    this.speed = 1.0;
    this.playing = false;
    this.startedAt = 0;
    this.pausedAt = 0;

    this.onSentenceStart = null; // (index) => void
    this.onFinished = null;
    this.onProgress = null; // (currentIndex, total) => void
  }

  _ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  reset() {
    this.stop();
    this.buffers.clear();
    this.currentIndex = -1;
    this.totalSentences = 0;
    this.pausedAt = 0;
  }

  setTotalSentences(count) {
    this.totalSentences = count;
  }

  async addChunk(index, wavArrayBuffer) {
    this._ensureContext();
    try {
      const audioBuffer = await this.ctx.decodeAudioData(wavArrayBuffer.slice(0));
      this.buffers.set(index, audioBuffer);

      if (this.currentIndex === -1 && index === 0) {
        this.playSentence(0);
      } else if (this.playing && this.currentSource === null && index === this.currentIndex) {
        this.playSentence(this.currentIndex);
      }
    } catch (e) {
      console.error("Failed to decode audio chunk", index, e);
    }
  }

  playSentence(index) {
    if (index < 0 || index >= this.totalSentences) return;
    if (!this.buffers.has(index)) {
      this.currentIndex = index;
      this.currentSource = null;
      this.onSentenceStart?.(index);
      this.onProgress?.(index, this.totalSentences);
      return;
    }

    this._ensureContext();
    this._stopCurrentSource();

    const buffer = this.buffers.get(index);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);

    source.onended = () => {
      if (this.currentSource === source && this.playing) {
        const next = this.currentIndex + 1;
        if (next < this.totalSentences) {
          this.playSentence(next);
        } else {
          this.playing = false;
          this.currentSource = null;
          this.onFinished?.();
        }
      }
    };

    this.currentSource = source;
    this.currentIndex = index;
    this.playing = true;
    this.pausedAt = 0;
    this.startedAt = this.ctx.currentTime;
    source.start(0);

    this.onSentenceStart?.(index);
    this.onProgress?.(index, this.totalSentences);
  }

  _stopCurrentSource() {
    if (this.currentSource) {
      try {
        this.currentSource.onended = null;
        this.currentSource.stop();
      } catch (_) {}
      this.currentSource = null;
    }
  }

  play() {
    if (this.playing) return;
    this._ensureContext();

    if (this.currentIndex >= 0) {
      this.playSentence(this.currentIndex);
    } else {
      this.playSentence(0);
    }
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this._stopCurrentSource();
  }

  togglePlayPause() {
    if (this.playing) {
      this.pause();
    } else {
      this.play();
    }
    return this.playing;
  }

  setSpeed(speed) {
    this.speed = Math.max(0.5, Math.min(2.0, speed));
  }

  skipSentences(delta) {
    const target = Math.max(0, Math.min(this.totalSentences - 1, this.currentIndex + delta));
    if (target !== this.currentIndex) {
      this.playSentence(target);
    }
  }

  stop() {
    this.playing = false;
    this._stopCurrentSource();
    this.currentIndex = -1;
  }

  getCurrentDuration() {
    if (this.currentIndex < 0 || !this.buffers.has(this.currentIndex)) return 0;
    return this.buffers.get(this.currentIndex).duration;
  }

  getTotalDuration() {
    let total = 0;
    for (let i = 0; i < this.totalSentences; i++) {
      if (this.buffers.has(i)) {
        total += this.buffers.get(i).duration;
      }
    }
    return total;
  }

  getElapsedDuration() {
    let elapsed = 0;
    for (let i = 0; i < this.currentIndex; i++) {
      if (this.buffers.has(i)) {
        elapsed += this.buffers.get(i).duration;
      }
    }
    return elapsed;
  }
}

window.__speakBlogsAudio = AudioEngine;
