(() => {
  let audio = null;
  let overlay = null;
  let active = false;
  let allSentences = [];
  let currentPort = null;
  let requestId = 0;
  let fetchedUpTo = -1;
  let totalWordCount = 0;
  let wordsPerSentence = [];
  let focusEl = null;
  let selectionRect = null;
  let savedSelectionRange = null;
  const BATCH = 5;

  // ── Sentence splitting ──

  function splitSentences(text) {
    const abbrevs = /(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|Inc|Ltd|Corp|approx|dept|est|govt|i\.e|e\.g)\./gi;
    const placeholder = "\u0000";
    let safe = text.replace(abbrevs, (m) => m.replace(".", placeholder));
    const raw = safe.split(/(?<=[.!?])\s+/);
    return raw
      .map((s) => s.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "g"), ".").trim())
      .filter((s) => s.length > 0);
  }

  function countWords(s) {
    return s.split(/\s+/).filter(Boolean).length;
  }

  // ── Time estimation ──
  // Kokoro at 1x ≈ 155 WPM. Scale linearly with speed.
  function estimateTime(currentIndex, speed) {
    let wordsRemaining = 0;
    for (let i = currentIndex; i < allSentences.length; i++) {
      wordsRemaining += wordsPerSentence[i] || 0;
    }
    const wpm = 155 * speed;
    return (wordsRemaining / wpm) * 60;
  }

  function estimateElapsed(currentIndex, speed) {
    let wordsElapsed = 0;
    for (let i = 0; i < currentIndex; i++) {
      wordsElapsed += wordsPerSentence[i] || 0;
    }
    const wpm = 155 * speed;
    return (wordsElapsed / wpm) * 60;
  }

  // ── Highlighting via CSS Custom Highlight API ──

  let sentenceRanges = [];

  function buildSentenceRanges(sentences) {
    sentenceRanges = [];
    try {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;

      const range = sel.getRangeAt(0);
      let searchNode = range.commonAncestorContainer;
      if (searchNode.nodeType === Node.TEXT_NODE) searchNode = searchNode.parentElement;

      const walker = document.createTreeWalker(searchNode, NodeFilter.SHOW_TEXT, null);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);

      let fullText = "";
      const nodeMap = [];
      for (const node of textNodes) {
        const start = fullText.length;
        fullText += node.textContent;
        nodeMap.push({ node, start, end: fullText.length });
      }

      const selText = range.toString().trim();
      const selStart = fullText.indexOf(selText);
      if (selStart === -1) return;

      let cursor = selStart;
      for (const sentence of sentences) {
        const sentStart = fullText.indexOf(sentence, cursor);
        if (sentStart === -1) {
          sentenceRanges.push(null);
          continue;
        }
        const sentEnd = sentStart + sentence.length;
        cursor = sentEnd;

        const affected = nodeMap.filter((n) => n.start < sentEnd && n.end > sentStart);
        if (affected.length === 0) {
          sentenceRanges.push(null);
          continue;
        }

        try {
          const r = new Range();
          const first = affected[0];
          const last = affected[affected.length - 1];
          r.setStart(first.node, Math.max(0, sentStart - first.start));
          r.setEnd(last.node, Math.min(last.node.textContent.length, sentEnd - last.start));
          sentenceRanges.push(r);
        } catch {
          sentenceRanges.push(null);
        }
      }
    } catch (e) {
      slog(`Range build error: ${e.message}`);
    }
  }

  function setActiveSentence(index) {
    if (CSS.highlights) {
      CSS.highlights.delete("speak-blogs-active");
      const r = sentenceRanges[index];
      if (r) {
        CSS.highlights.set("speak-blogs-active", new Highlight(r));
        const rect = r.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
          r.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }
  }

  function clearHighlights() {
    if (CSS.highlights) CSS.highlights.delete("speak-blogs-active");
    sentenceRanges = [];
  }

  // ── Focus mode ──

  function createFocusMode() {
    removeFocusMode();

    if (!savedSelectionRange) return;

    const rects = savedSelectionRange.getClientRects();
    if (!rects.length) return;

    // Get bounding box of entire selection
    let top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity;
    for (const r of rects) {
      top = Math.min(top, r.top);
      left = Math.min(left, r.left);
      bottom = Math.max(bottom, r.bottom);
      right = Math.max(right, r.right);
    }

    const pad = 20;
    selectionRect = {
      top: top + window.scrollY - pad,
      left: left - pad,
      width: right - left + pad * 2,
      height: bottom - top + pad * 2,
    };

    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const dimColor = isDark ? "rgba(0, 0, 0, 0.75)" : "rgba(0, 0, 0, 0.6)";

    focusEl = document.createElement("speak-blogs-focus");
    focusEl.style.cssText = `
      position: absolute;
      top: ${selectionRect.top}px;
      left: ${selectionRect.left}px;
      width: ${selectionRect.width}px;
      height: ${selectionRect.height}px;
      border-radius: 8px;
      box-shadow: 0 0 0 200vmax rgba(0, 0, 0, 0);
      z-index: 2147483640;
      pointer-events: none;
      transition: box-shadow 0.6s cubic-bezier(0.4, 0, 0.2, 1);
    `;
    document.body.appendChild(focusEl);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (focusEl) {
          focusEl.style.boxShadow = `0 0 0 200vmax ${dimColor}`;
        }
      });
    });
  }

  function removeFocusMode() {
    if (focusEl) {
      focusEl.style.boxShadow = "0 0 0 200vmax rgba(0, 0, 0, 0)";
      const el = focusEl;
      setTimeout(() => el.remove(), 600);
      focusEl = null;
    }
    selectionRect = null;
  }

  // ── Batching / pipeline ──

  function sendBatch(fromIndex, speed) {
    if (!currentPort || fromIndex >= allSentences.length) return;
    if (fromIndex <= fetchedUpTo) return;
    const toIndex = Math.min(fromIndex + BATCH, allSentences.length);
    const batch = allSentences.slice(fromIndex, toIndex);
    fetchedUpTo = toIndex - 1;
    slog(`Batch [${fromIndex}..${toIndex - 1}] reqId=${requestId} speed=${speed}`);
    currentPort.postMessage({
      type: "send-sentences",
      sentences: batch,
      voice: overlay.currentVoice,
      speed,
      startIndex: fromIndex,
      requestId,
    });
  }

  function prefetch(triggerIndex, speed) {
    if (fetchedUpTo < allSentences.length - 1 && triggerIndex + 2 >= fetchedUpTo) {
      sendBatch(fetchedUpTo + 1, speed);
    }
  }

  function cancelAndRegenerate(newSpeed) {
    if (!currentPort || !audio || !allSentences.length) return;
    const idx = Math.max(0, audio.currentIndex);

    requestId++;
    currentPort.postMessage({ type: "cancel" });

    // Don't pause — keep playing state, just clear future buffers
    for (let i = idx; i < allSentences.length; i++) audio.buffers.delete(i);
    fetchedUpTo = idx - 1;

    sendBatch(idx, newSpeed);
    // Re-trigger play on current index so it picks up new audio when it arrives
    audio.playSentence(idx);
    overlay.setPlayState(true);
  }

  // ── Base64 decode ──

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  // ── Progress update ──

  function updateProgress(index) {
    if (!overlay) return;
    const speed = overlay.currentSpeed;
    const elapsed = estimateElapsed(index, speed);
    const total = elapsed + estimateTime(index, speed);
    overlay.updateProgress(index, allSentences.length, elapsed, total);
  }

  // ── Main ──

  async function startSpeaking() {
    try {
      const selection = window.getSelection();
      const text = selection?.toString()?.trim();
      if (!text) return;

      savedSelectionRange = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;

      if (active) shutdown();

      const sentences = splitSentences(text);
      if (!sentences.length) return;

      active = true;
      allSentences = sentences;
      fetchedUpTo = -1;
      requestId++;

      wordsPerSentence = sentences.map(countWords);
      totalWordCount = wordsPerSentence.reduce((a, b) => a + b, 0);

      const AudioEngine = window.__speakBlogsAudio;
      const SpeakOverlay = window.__speakBlogsOverlay;

      audio = new AudioEngine();
      overlay = new SpeakOverlay();

      await overlay.fetchVoices();
      overlay.create();
      slog(`Started: ${sentences.length} sentences, ${totalWordCount} words, voice=${overlay.currentVoice}, speed=${overlay.currentSpeed}`);

      audio.setTotalSentences(sentences.length);
      buildSentenceRanges(sentences);

      audio.onSentenceStart = (index) => {
        setActiveSentence(index);
        updateProgress(index);
        prefetch(index, overlay.currentSpeed);
      };

      audio.onFinished = () => {
        slog("Finished");
        overlay.setPlayState(false);
        clearHighlights();
        removeFocusMode();
      };

      overlay.onPlayPause = () => {
        const playing = audio.togglePlayPause();
        overlay.setPlayState(playing);
      };

      overlay.onSkip = (delta) => {
        const target = Math.max(0, Math.min(allSentences.length - 1, audio.currentIndex + delta));
        if (!audio.buffers.has(target) && target > fetchedUpTo) {
          fetchedUpTo = target - 1;
          sendBatch(target, overlay.currentSpeed);
        }
        audio.skipSentences(delta);
      };

      overlay.onSpeedChange = (speed) => {
        slog(`Speed → ${speed}`);
        cancelAndRegenerate(speed);
      };

      overlay.onVoiceChange = (voiceId) => {
        slog(`Voice → ${voiceId}`);
        cancelAndRegenerate(overlay.currentSpeed);
      };

      overlay.onFocusToggle = (on) => {
        if (on) createFocusMode();
        else removeFocusMode();
      };

      overlay.onClose = () => shutdown();

      const port = chrome.runtime.connect({ name: "speak-blogs-tts" });
      currentPort = port;

      port.onMessage.addListener((msg) => {
        if (msg.type === "audio-chunk") {
          if (msg.requestId !== undefined && msg.requestId !== requestId) return;
          audio.addChunk(msg.index, base64ToArrayBuffer(msg.base64));
          // Prefetch on chunk arrival too — don't wait for playback
          prefetch(msg.index, overlay.currentSpeed);
        } else if (msg.type === "done") {
          // Batch done — check if more needed
          if (fetchedUpTo < allSentences.length - 1) {
            sendBatch(fetchedUpTo + 1, overlay.currentSpeed);
          }
        } else if (msg.type === "error") {
          slog(`Error: ${JSON.stringify(msg)}`);
          overlay.showStatus(msg.message || "TTS error");
        }
      });

      sendBatch(0, overlay.currentSpeed);
      overlay.setPlayState(true);
      updateProgress(0);
    } catch (err) {
      slog(`FATAL: ${err.message}\n${err.stack}`);
    }
  }

  function shutdown() {
    active = false;
    allSentences = [];
    wordsPerSentence = [];
    totalWordCount = 0;
    fetchedUpTo = -1;
    requestId++;
    audio?.stop();
    audio?.reset();
    try { currentPort?.disconnect(); } catch (_) {}
    overlay?.destroy();
    clearHighlights();
    removeFocusMode();
    currentPort = null;
    audio = null;
    overlay = null;
    savedSelectionRange = null;
  }

  // ── Keyboard shortcuts ──

  document.addEventListener("keydown", (e) => {
    if (!active || !audio || !overlay) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;

    switch (e.code) {
      case "Space":
        e.preventDefault();
        overlay.onPlayPause?.();
        break;
      case "ArrowLeft":
        e.preventDefault();
        overlay.onSkip?.(e.shiftKey ? -5 : -1);
        break;
      case "ArrowRight":
        e.preventDefault();
        overlay.onSkip?.(e.shiftKey ? 5 : 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        overlay.setSpeed(Math.min(2, overlay.currentSpeed + 0.25));
        overlay.onSpeedChange?.(overlay.currentSpeed);
        break;
      case "ArrowDown":
        e.preventDefault();
        overlay.setSpeed(Math.max(0.5, overlay.currentSpeed - 0.25));
        overlay.onSpeedChange?.(overlay.currentSpeed);
        break;
      case "Escape":
        e.preventDefault();
        shutdown();
        break;
    }
  });

  // ── Logging ──

  function slog(msg) {
    console.log("[speak-blogs]", msg);
    fetch(`http://127.0.0.1:7890/log?msg=${encodeURIComponent("[content] " + msg)}`).catch(() => {});
  }

  // ── Message listener ──

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "ping") { sendResponse({ pong: true }); return; }
    if (msg.action === "speak-selection") {
      startSpeaking();
      sendResponse({ ok: true });
    }
  });

  slog("Content script loaded");
})();
