class TTSWebSocket {
  constructor(url = "ws://127.0.0.1:7890/ws") {
    this.url = url;
    this.ws = null;
    this.onAudioChunk = null; // (index, wavArrayBuffer) => void
    this.onDone = null;
    this.onError = null;
    this.onConnectionChange = null; // (connected: boolean) => void
    this._reconnectTimer = null;
    this._intentionalClose = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this._intentionalClose = false;
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        this.onConnectionChange?.(true);
        resolve();
      };

      this.ws.onerror = () => {
        this.onConnectionChange?.(false);
        reject(new Error("WebSocket connection failed"));
      };

      this.ws.onclose = () => {
        this.onConnectionChange?.(false);
        if (!this._intentionalClose) {
          this._scheduleReconnect();
        }
      };

      this.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const view = new DataView(event.data);
          const index = view.getUint32(0, true);
          const audioLen = view.getUint32(4, true);
          const audioData = event.data.slice(8, 8 + audioLen);
          this.onAudioChunk?.(index, audioData);
        } else {
          const msg = JSON.parse(event.data);
          if (msg.type === "done") {
            this.onDone?.();
          } else if (msg.type === "error") {
            this.onError?.(msg);
          }
        }
      };
    });
  }

  async sendSentences(sentences, voice) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    this.ws.send(JSON.stringify({ sentences, voice }));
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {});
    }, 3000);
  }

  close() {
    this._intentionalClose = true;
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

window.__speakBlogsWS = TTSWebSocket;
