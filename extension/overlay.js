class SpeakOverlay {
  constructor() {
    this.host = null;
    this.shadow = null;
    this.root = null;
    this.mini = false;
    this.voices = [];
    this.currentVoice = localStorage.getItem("speak-blogs-voice") || "af_sarah";
    this.currentSpeed = parseFloat(localStorage.getItem("speak-blogs-speed")) || 1.5;
    this.dragging = false;
    this.dragOffset = { x: 0, y: 0 };

    this.onPlayPause = null;
    this.onSkip = null;
    this.onSpeedChange = null;
    this.onVoiceChange = null;
    this.onFocusToggle = null;
    this.onClose = null;
    this.onSaveNote = null;
    this.focusMode = false;
    this._noteResolve = null;
  }

  async fetchVoices() {
    try {
      const res = await fetch("http://127.0.0.1:7890/voices");
      this.voices = await res.json();
    } catch {
      this.voices = {};
    }
  }

  create() {
    if (this.host) return;

    this.host = document.createElement("speak-blogs-overlay");
    this.host.style.cssText = `
      position: fixed;
      bottom: 16px;
      right: 16px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    `;

    this.shadow = this.host.attachShadow({ mode: "closed" });
    this.shadow.innerHTML = `
      <style>${this._styles()}</style>
      <div class="overlay" id="overlay">
        <div class="top-bar" id="drag-handle">
          <span class="time-remaining" id="time"><span class="time-value">0:00</span> left</span>
          <div class="top-spacer"></div>
          <button class="btn win-btn" id="note-btn" title="Jot a note (⌘J)">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
          </button>
          <button class="btn win-btn" id="collapse-btn" title="Minimize">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
          <button class="btn win-btn close-btn" id="close-btn" title="Close">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="controls" id="controls">
          <div class="progress-row">
            <div class="progress-bar" id="progress-bar">
              <div class="progress-fill" id="progress-fill"></div>
            </div>
          </div>
          <div class="row row-playback">
            <button class="btn nav" data-skip="-5" title="Back 5 sentences">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>
              </svg>
            </button>
            <button class="btn nav" data-skip="-1" title="Back 1 sentence">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>
            <button class="btn play-pause" id="play-pause" title="Play/Pause">
              <svg class="icon-play" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6,3 20,12 6,21"/>
              </svg>
              <svg class="icon-pause" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="display:none">
                <rect x="5" y="3" width="4" height="18" rx="1"/><rect x="15" y="3" width="4" height="18" rx="1"/>
              </svg>
            </button>
            <button class="btn nav" data-skip="1" title="Forward 1 sentence">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
            <button class="btn nav" data-skip="5" title="Forward 5 sentences">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 17 11 12 6 7"/><polyline points="13 17 18 12 13 7"/>
              </svg>
            </button>
          </div>
          <div class="row row-options">
            <div class="speed-group" id="speed-group">
              ${[0.5, 1, 1.5, 2].map(s =>
                `<button class="btn speed ${s === this.currentSpeed ? 'active' : ''}" data-speed="${s}">${s}x</button>`
              ).join("")}
            </div>
            <div class="separator-v"></div>
            <div class="voice-wrapper" id="voice-wrapper">
              <button class="btn voice-btn" id="voice-btn">
                <span id="voice-label">${this._voiceName(this.currentVoice)}</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              <div class="voice-dropdown" id="voice-dropdown"></div>
            </div>
            <button class="btn toggle-btn" id="focus-btn">
              <span class="toggle-label">Focus Mode</span>
              <span class="toggle-track" id="focus-track">
                <span class="toggle-thumb"></span>
              </span>
            </button>
          </div>
        </div>
        <div class="mini-controls" id="mini-controls" style="display:none">
          <button class="btn play-pause" id="mini-play-pause" title="Play/Pause">
            <svg class="icon-play" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6,3 20,12 6,21"/>
            </svg>
            <svg class="icon-pause" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display:none">
              <rect x="5" y="3" width="4" height="18" rx="1"/><rect x="15" y="3" width="4" height="18" rx="1"/>
            </svg>
          </button>
          <span class="mini-speed" id="mini-speed">${this.currentSpeed}x</span>
          <span class="mini-voice" id="mini-voice">${this._voiceName(this.currentVoice)}</span>
          <button class="btn win-btn" id="expand-btn" title="Expand">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
            </svg>
          </button>
          <button class="btn win-btn close-btn" id="mini-close-btn" title="Close">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="status-bar" id="status-bar" style="display:none">
          <span id="status-text"></span>
        </div>
      </div>
    `;

    document.body.appendChild(this.host);
    this._restorePosition();
    this._bindEvents();
    this._buildVoiceDropdown();
  }

  _voiceName(id) {
    const names = {
      af_heart: "Heart", af_bella: "Bella", af_sarah: "Sarah", af_nicole: "Nicole",
      am_adam: "Adam", am_michael: "Michael",
      bf_emma: "Emma", bf_isabella: "Isabella",
      bm_george: "George", bm_lewis: "Lewis",
    };
    return names[id] || id;
  }

  _buildVoiceDropdown() {
    const dd = this.shadow.getElementById("voice-dropdown");
    if (!Object.keys(this.voices).length) {
      dd.innerHTML = `<div class="voice-group"><div class="voice-group-label">Voices unavailable</div></div>`;
      return;
    }
    let html = "";
    for (const [group, voices] of Object.entries(this.voices)) {
      html += `<div class="voice-group"><div class="voice-group-label">${group}</div>`;
      for (const v of voices) {
        const active = v.id === this.currentVoice ? "active" : "";
        html += `<button class="voice-option ${active}" data-voice="${v.id}">${v.name}</button>`;
      }
      html += `</div>`;
    }
    dd.innerHTML = html;

    dd.querySelectorAll(".voice-option").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const voiceId = btn.dataset.voice;
        this.currentVoice = voiceId;
        localStorage.setItem("speak-blogs-voice", voiceId);
        this.shadow.getElementById("voice-label").textContent = this._voiceName(voiceId);
        this.shadow.getElementById("mini-voice").textContent = this._voiceName(voiceId);
        dd.classList.remove("open");
        dd.querySelectorAll(".voice-option").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.onVoiceChange?.(voiceId);
      });
    });
  }

  _bindEvents() {
    const $ = (id) => this.shadow.getElementById(id);

    // Play/Pause
    $("play-pause").addEventListener("click", () => this.onPlayPause?.());
    $("mini-play-pause").addEventListener("click", () => this.onPlayPause?.());

    // Navigation
    this.shadow.querySelectorAll("[data-skip]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.onSkip?.(parseInt(btn.dataset.skip));
      });
    });

    // Speed
    this.shadow.querySelectorAll("[data-speed]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const speed = parseFloat(btn.dataset.speed);
        this.setSpeed(speed);
        this.onSpeedChange?.(speed);
      });
    });

    // Voice dropdown toggle
    $("voice-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      $("voice-dropdown").classList.toggle("open");
    });

    // Close dropdown on outside click
    this.shadow.addEventListener("click", () => {
      $("voice-dropdown")?.classList.remove("open");
    });

    // Focus mode
    $("focus-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      this.focusMode = !this.focusMode;
      $("focus-track").classList.toggle("on", this.focusMode);
      this.onFocusToggle?.(this.focusMode);
    });

    // Collapse / Expand
    $("collapse-btn").addEventListener("click", () => this._toggleMini(true));
    $("expand-btn").addEventListener("click", () => this._toggleMini(false));

    // Note
    $("note-btn").addEventListener("click", () => this.onSaveNote?.());

    // Close
    $("close-btn").addEventListener("click", () => this.onClose?.());
    $("mini-close-btn").addEventListener("click", () => this.onClose?.());


    // Dragging — both full and mini mode
    const handle = $("drag-handle");
    const miniBar = $("mini-controls");
    handle.addEventListener("mousedown", (e) => this._startDrag(e));
    miniBar.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      this._startDrag(e);
    });
    document.addEventListener("mousemove", (e) => this._onDrag(e));
    document.addEventListener("mouseup", () => this._endDrag());
  }

  _startDrag(e) {
    this.dragging = true;
    const rect = this.host.getBoundingClientRect();
    this.dragOffset.x = e.clientX - rect.left;
    this.dragOffset.y = e.clientY - rect.top;
    this.host.style.transition = "none";
  }

  _onDrag(e) {
    if (!this.dragging) return;
    const x = e.clientX - this.dragOffset.x;
    const y = e.clientY - this.dragOffset.y;
    this.host.style.left = `${x}px`;
    this.host.style.top = `${y}px`;
    this.host.style.right = "auto";
    this.host.style.bottom = "auto";
  }

  _endDrag() {
    if (!this.dragging) return;
    this.dragging = false;
    this.host.style.transition = "";
    this._savePosition();
  }

  _savePosition() {
    const rect = this.host.getBoundingClientRect();
    localStorage.setItem("speak-blogs-pos", JSON.stringify({ x: rect.left, y: rect.top }));
  }

  _restorePosition() {
    try {
      const pos = JSON.parse(localStorage.getItem("speak-blogs-pos"));
      if (pos) {
        this.host.style.left = `${pos.x}px`;
        this.host.style.top = `${pos.y}px`;
        this.host.style.right = "auto";
        this.host.style.bottom = "auto";
      }
    } catch {}
  }

  _toggleMini(mini) {
    this.mini = mini;
    this.shadow.getElementById("drag-handle").style.display = mini ? "none" : "";
    this.shadow.getElementById("controls").style.display = mini ? "none" : "";
    const mc = this.shadow.getElementById("mini-controls");
    mc.style.display = mini ? "" : "none";
    this.shadow.getElementById("overlay").style.width = mini ? "auto" : "";
  }

  setPlayState(playing) {
    for (const container of [
      this.shadow.getElementById("play-pause"),
      this.shadow.getElementById("mini-play-pause"),
    ]) {
      container.querySelector(".icon-play").style.display = playing ? "none" : "";
      container.querySelector(".icon-pause").style.display = playing ? "" : "none";
    }
  }

  setSpeed(speed) {
    this.currentSpeed = speed;
    localStorage.setItem("speak-blogs-speed", speed);
    this.shadow.querySelectorAll("[data-speed]").forEach((btn) => {
      btn.classList.toggle("active", parseFloat(btn.dataset.speed) === speed);
    });
    this.shadow.getElementById("mini-speed").textContent = `${speed}x`;
  }

  updateProgress(current, total, elapsedSec, totalSec) {
    const pct = total > 0 ? ((current + 1) / total) * 100 : 0;
    this.shadow.getElementById("progress-fill").style.width = `${pct}%`;

    const remaining = Math.max(0, Math.ceil(totalSec - elapsedSec));
    const hrs = Math.floor(remaining / 3600);
    const min = Math.floor((remaining % 3600) / 60);
    const sec = remaining % 60;

    const timeEl = this.shadow.getElementById("time");
    if (hrs > 0) {
      const ts = `${hrs}:${min.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
      timeEl.innerHTML = `<span class="time-value">${ts}</span> hours left`;
    } else if (min > 0) {
      const ts = `${min}:${sec.toString().padStart(2, "0")}`;
      timeEl.innerHTML = `<span class="time-value">${ts}</span> minutes left`;
    } else {
      timeEl.innerHTML = `<span class="time-value">${sec}</span> seconds left`;
    }
  }

  showStatus(text) {
    const bar = this.shadow.getElementById("status-bar");
    this.shadow.getElementById("status-text").textContent = text;
    bar.style.display = "";
    setTimeout(() => { bar.style.display = "none"; }, 3000);
  }

  setConnected(connected) {
    if (!connected) {
      this.showStatus("Server offline — start the TTS server");
    }
  }

  _noteModalCSS(isDark) {
    return `* { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
        display: flex; align-items: center; justify-content: center;
        min-height: 100vh; background: rgba(0,0,0,0.4);
      }
      .modal {
        background: ${isDark ? "rgba(35,35,35,0.97)" : "rgba(255,255,255,0.97)"};
        border: 1px solid ${isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)"};
        border-radius: 14px;
        box-shadow: ${isDark ? "0 12px 40px rgba(0,0,0,0.4)" : "0 12px 40px rgba(0,0,0,0.12), 0 4px 12px rgba(0,0,0,0.06)"};
        width: 380px; max-width: 90vw; padding: 16px;
        display: flex; flex-direction: column; gap: 12px;
        font-size: 13px; color: ${isDark ? "#e0e0e0" : "#1a1a1a"}; line-height: 1.4;
      }
      .header { display: flex; align-items: center; justify-content: space-between; }
      .title { font-size: 13px; font-weight: 600; }
      .close-btn {
        background: none; border: none; cursor: pointer; padding: 4px;
        color: ${isDark ? "#888" : "#666"}; border-radius: 6px;
      }
      .close-btn:hover { background: ${isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.05)"}; }
      .sentence {
        font-size: 12px; color: ${isDark ? "#aaa" : "#555"};
        background: ${isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)"};
        border-radius: 8px; padding: 10px 12px; max-height: 80px; overflow-y: auto;
        line-height: 1.5; border-left: 3px solid ${isDark ? "#f05050" : "#dc3232"};
      }
      textarea {
        width: 100%; border: 1px solid ${isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"};
        border-radius: 8px; padding: 10px 12px; font-size: 13px; font-family: inherit;
        background: ${isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.02)"};
        color: ${isDark ? "#e0e0e0" : "#1a1a1a"}; resize: vertical; outline: none;
        transition: border-color 0.15s; line-height: 1.5;
      }
      textarea:focus { border-color: ${isDark ? "#f05050" : "#dc3232"}; }
      .actions { display: flex; align-items: center; justify-content: space-between; }
      .hint { font-size: 10px; color: #999; }
      .save-btn {
        background: ${isDark ? "#f05050" : "#dc3232"}; color: #fff; border: none;
        border-radius: 8px; padding: 6px 16px; font-size: 12px; font-weight: 600;
        cursor: pointer; transition: background 0.15s;
      }
      .save-btn:hover { background: ${isDark ? "#e04040" : "#c52a2a"}; }`;
  }

  showNoteModal(sentenceText) {
    return new Promise((resolve) => {
      this._noteResolve = resolve;
      if (this._noteFrame) this._noteFrame.remove();

      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

      const frame = document.createElement("iframe");
      frame.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;border:none;z-index:2147483647;background:transparent;";
      document.body.appendChild(frame);
      this._noteFrame = frame;

      const doc = frame.contentDocument;
      const style = doc.createElement("style");
      style.textContent = this._noteModalCSS(isDark);
      doc.head.appendChild(style);

      doc.body.innerHTML = `
        <div class="modal">
          <div class="header">
            <span class="title">Save Note</span>
            <button class="close-btn" id="cancel-btn">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div class="sentence" id="note-sentence"></div>
          <textarea id="note-input" placeholder="Add your thoughts (optional)..." rows="3"></textarea>
          <div class="actions">
            <span class="hint">Enter to save · Esc to cancel</span>
            <button class="save-btn" id="save-btn">Save</button>
          </div>
        </div>`;

      doc.getElementById("note-sentence").textContent = sentenceText;
      const input = doc.getElementById("note-input");

      const finish = (save) => {
        const text = save ? (input.value.trim() || null) : undefined;
        if (this._noteFrame) { this._noteFrame.remove(); this._noteFrame = null; }
        if (this._noteResolve) { this._noteResolve(text); this._noteResolve = null; }
      };

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); finish(false); }
      });
      doc.getElementById("save-btn").addEventListener("click", () => finish(true));
      doc.getElementById("cancel-btn").addEventListener("click", () => finish(false));
      doc.body.addEventListener("click", (e) => { if (e.target === doc.body) finish(false); });

      input.focus();
    });
  }

  _hideNoteModal(save) {
    if (this._noteFrame) {
      this._noteFrame.remove();
      this._noteFrame = null;
    }
    if (this._noteResolve) {
      this._noteResolve(save ? null : undefined);
      this._noteResolve = null;
    }
  }

  destroy() {
    if (this._noteFrame) { this._noteFrame.remove(); this._noteFrame = null; }
    if (this._noteResolve) {
      this._noteResolve(undefined);
      this._noteResolve = null;
    }
    if (this.host) {
      this.host.remove();
      this.host = null;
      this.shadow = null;
    }
  }

  _styles() {
    return `
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      .overlay {
        background: rgba(255, 255, 255, 0.72);
        backdrop-filter: blur(16px) saturate(180%);
        -webkit-backdrop-filter: blur(16px) saturate(180%);
        border: 1px solid rgba(0, 0, 0, 0.08);
        border-radius: 14px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04);
        padding: 0;
        display: flex;
        flex-direction: column;
        user-select: none;
        color: #1a1a1a;
        font-size: 12px;
        line-height: 1;
        width: 260px;
        overflow: hidden;
      }
      @media (prefers-color-scheme: dark) {
        .overlay {
          background: rgba(30, 30, 30, 0.78);
          border-color: rgba(255, 255, 255, 0.08);
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), 0 2px 8px rgba(0, 0, 0, 0.2);
          color: #e0e0e0;
        }
      }

      /* Top bar: drag area + window controls */
      .top-bar {
        display: flex;
        align-items: center;
        padding: 7px 8px 5px 12px;
        cursor: grab;
      }
      .top-bar:active { cursor: grabbing; }

      .time-remaining {
        font-size: 10px;
        color: #999;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        letter-spacing: 0.2px;
      }
      .time-value {
        font-weight: 600;
        color: #666;
      }
      @media (prefers-color-scheme: dark) {
        .time-remaining { color: #777; }
        .time-value { color: #aaa; }
      }

      .top-spacer { flex: 1; }

      .win-btn {
        color: #bbb;
        padding: 3px;
        border-radius: 6px;
        margin-left: 2px;
      }
      .win-btn:hover { color: #888; background: rgba(0, 0, 0, 0.06); }
      .close-btn:hover { color: #e55 !important; background: rgba(220, 50, 50, 0.08) !important; }
      @media (prefers-color-scheme: dark) {
        .win-btn { color: #666; }
        .win-btn:hover { color: #aaa; background: rgba(255, 255, 255, 0.06); }
      }

      /* Controls area */
      .controls {
        display: flex;
        flex-direction: column;
        gap: 0;
        padding: 0 10px 10px;
      }

      .progress-row {
        padding: 0 2px 8px;
      }
      .progress-bar {
        width: 100%;
        height: 3px;
        background: rgba(0, 0, 0, 0.06);
        border-radius: 2px;
        overflow: hidden;
      }
      @media (prefers-color-scheme: dark) {
        .progress-bar { background: rgba(255, 255, 255, 0.08); }
      }
      .progress-fill {
        height: 100%;
        background: #dc3232;
        border-radius: 2px;
        transition: width 0.3s ease;
        width: 0%;
      }
      @media (prefers-color-scheme: dark) {
        .progress-fill { background: #f05050; }
      }

      .row {
        display: flex;
        align-items: center;
      }

      .row-playback {
        justify-content: center;
        gap: 4px;
        padding-bottom: 8px;
      }

      .row-options {
        gap: 4px;
        padding-top: 8px;
        border-top: 1px solid rgba(0, 0, 0, 0.05);
        flex-wrap: wrap;
        justify-content: space-between;
      }
      @media (prefers-color-scheme: dark) {
        .row-options { border-top-color: rgba(255, 255, 255, 0.06); }
      }

      .separator-v {
        width: 1px;
        height: 16px;
        background: rgba(0, 0, 0, 0.07);
      }
      @media (prefers-color-scheme: dark) {
        .separator-v { background: rgba(255, 255, 255, 0.07); }
      }

      .btn {
        background: none;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        color: inherit;
        border-radius: 8px;
        transition: background 0.15s ease, transform 0.1s ease;
        padding: 6px;
        outline: none;
      }
      .btn:hover { background: rgba(0, 0, 0, 0.06); }
      .btn:active { transform: scale(0.94); }
      @media (prefers-color-scheme: dark) {
        .btn:hover { background: rgba(255, 255, 255, 0.08); }
      }

      .nav { color: #777; padding: 5px; }
      @media (prefers-color-scheme: dark) { .nav { color: #999; } }

      .play-pause {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        background: rgba(220, 50, 50, 0.1);
        color: #dc3232;
        margin: 0 4px;
      }
      .play-pause:hover { background: rgba(220, 50, 50, 0.18); }
      @media (prefers-color-scheme: dark) {
        .play-pause { background: rgba(240, 80, 80, 0.15); color: #f05050; }
        .play-pause:hover { background: rgba(240, 80, 80, 0.25); }
      }

      .speed-group { display: flex; gap: 1px; }
      .speed {
        padding: 4px 7px;
        border-radius: 8px;
        font-size: 11px;
        font-weight: 500;
        color: #777;
      }
      .speed.active {
        background: rgba(220, 50, 50, 0.1);
        color: #dc3232;
        font-weight: 600;
      }
      @media (prefers-color-scheme: dark) {
        .speed { color: #888; }
        .speed.active { background: rgba(240, 80, 80, 0.15); color: #f05050; }
      }

      .voice-wrapper { position: relative; }
      .voice-btn {
        gap: 4px;
        padding: 4px 8px;
        border-radius: 8px;
        font-size: 11px;
        font-weight: 500;
      }

      .voice-dropdown {
        display: none;
        position: absolute;
        bottom: calc(100% + 8px);
        left: 50%;
        transform: translateX(-50%);
        background: rgba(255, 255, 255, 0.92);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(0, 0, 0, 0.08);
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
        padding: 6px;
        min-width: 140px;
        z-index: 10;
      }
      .voice-dropdown.open { display: block; }
      @media (prefers-color-scheme: dark) {
        .voice-dropdown {
          background: rgba(40, 40, 40, 0.92);
          border-color: rgba(255, 255, 255, 0.08);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
        }
      }

      .voice-group { margin-bottom: 4px; }
      .voice-group:last-child { margin-bottom: 0; }
      .voice-group-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: #999;
        padding: 4px 8px 2px;
      }
      .voice-option {
        display: block;
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        padding: 5px 8px;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        color: inherit;
        transition: background 0.12s;
      }
      .voice-option:hover { background: rgba(0, 0, 0, 0.05); }
      .voice-option.active { color: #dc3232; font-weight: 600; }
      @media (prefers-color-scheme: dark) {
        .voice-option:hover { background: rgba(255, 255, 255, 0.06); }
        .voice-option.active { color: #f05050; }
      }

      /* Focus mode toggle */
      .toggle-btn {
        gap: 6px;
        padding: 3px 6px;
        border-radius: 8px;
        margin-left: auto;
      }
      .toggle-btn:hover { background: rgba(0, 0, 0, 0.04); }
      .toggle-label {
        font-size: 10px;
        font-weight: 500;
        color: #999;
      }
      .toggle-track {
        display: inline-block;
        width: 26px;
        height: 14px;
        border-radius: 7px;
        background: rgba(0, 0, 0, 0.12);
        position: relative;
        transition: background 0.2s ease;
        vertical-align: middle;
      }
      .toggle-track.on { background: #dc3232; }
      @media (prefers-color-scheme: dark) {
        .toggle-track { background: rgba(255, 255, 255, 0.15); }
        .toggle-track.on { background: #f05050; }
      }
      .toggle-thumb {
        position: absolute;
        top: 2px;
        left: 2px;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #fff;
        transition: transform 0.2s ease;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
      }
      .toggle-track.on .toggle-thumb { transform: translateX(12px); }

      /* Mini controls */
      .mini-controls {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 8px;
        cursor: grab;
      }
      .mini-controls:active { cursor: grabbing; }
      .mini-controls .play-pause {
        width: 28px;
        height: 28px;
        margin: 0;
      }
      .mini-speed, .mini-voice {
        font-size: 11px;
        font-weight: 500;
        color: #888;
      }

      .status-bar {
        padding: 4px 8px;
        font-size: 10px;
        color: #e88;
        text-align: center;
      }

    `;
  }
}

window.__speakBlogsOverlay = SpeakOverlay;
