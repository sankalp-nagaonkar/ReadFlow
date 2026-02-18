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

  function getSelectedTextNodes(range) {
    const nodes = [];
    const root = range.commonAncestorContainer;
    const walkRoot = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
    const walker = document.createTreeWalker(walkRoot, NodeFilter.SHOW_TEXT, null);

    // Determine the actual start/end text nodes and offsets,
    // handling cases where the range anchors on element nodes.
    let startNode = range.startContainer;
    let startOff = range.startOffset;
    let endNode = range.endContainer;
    let endOff = range.endOffset;

    if (startNode.nodeType !== Node.TEXT_NODE) {
      const child = startNode.childNodes[startOff];
      if (child) {
        const tw = document.createTreeWalker(child, NodeFilter.SHOW_TEXT, null);
        if (tw.nextNode()) { startNode = tw.currentNode; startOff = 0; }
      }
    }
    if (endNode.nodeType !== Node.TEXT_NODE) {
      const child = endNode.childNodes[Math.max(0, endOff - 1)];
      if (child) {
        const tw = document.createTreeWalker(child, NodeFilter.SHOW_TEXT, null);
        let last = null;
        while (tw.nextNode()) last = tw.currentNode;
        if (last) { endNode = last; endOff = last.textContent.length; }
      }
    }

    if (startNode === endNode && startNode.nodeType === Node.TEXT_NODE) {
      nodes.push({ node: startNode, from: startOff, to: endOff });
      return nodes;
    }

    let inRange = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node === startNode) {
        inRange = true;
        nodes.push({ node, from: startOff, to: node.textContent.length });
        if (node === endNode) break;
        continue;
      }
      if (node === endNode) {
        nodes.push({ node, from: 0, to: endOff });
        break;
      }
      if (inRange) {
        nodes.push({ node, from: 0, to: node.textContent.length });
      }
    }
    return nodes;
  }

  function isBlockBoundary(nodeA, nodeB) {
    if (!nodeA || !nodeB) return false;
    const elA = nodeA.nodeType === Node.TEXT_NODE ? nodeA.parentElement : nodeA;
    const elB = nodeB.nodeType === Node.TEXT_NODE ? nodeB.parentElement : nodeB;
    if (!elA || !elB) return false;

    const blockSel = "p, div, h1, h2, h3, h4, h5, h6, li, blockquote, pre, tr, section, article, dd, dt, figure, figcaption";
    return elA.closest(blockSel) !== elB.closest(blockSel);
  }

  function buildSentenceRanges(sentences) {
    sentenceRanges = [];
    try {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const textNodes = getSelectedTextNodes(range);
      if (!textNodes.length) return;

      // Build flat text matching what selection.toString() produces,
      // with a char-level map back to (nodeIndex, offset) in textNodes.
      let flatText = "";
      const charMap = []; // charMap[i] = { ni: nodeIndex, off: offset }

      for (let ni = 0; ni < textNodes.length; ni++) {
        const tn = textNodes[ni];
        const text = tn.node.textContent.substring(tn.from, tn.to);

        if (ni > 0 && isBlockBoundary(textNodes[ni - 1].node, tn.node)) {
          flatText += "\n";
          charMap.push(null);
        } else if (ni > 0 && flatText.length > 0 && !/\s$/.test(flatText) && !/^\s/.test(text) && text.length > 0) {
          // Inline nodes with no whitespace gap — don't insert anything.
          // Bold text like "<b>word</b> next" already has space in the text nodes.
        }

        for (let ci = 0; ci < text.length; ci++) {
          charMap.push({ ni, off: tn.from + ci });
          flatText += text[ci];
        }
      }

      // Build normFlat and a mapping from each normFlat char index to flatText char index.
      // This mirrors how .replace(/\s+/g, " ").trim() works, tracking positions.
      const normToFlat = [];
      let normFlat = "";
      let inWS = false;
      let started = false;
      for (let fi = 0; fi < flatText.length; fi++) {
        const ch = flatText[fi];
        if (/\s/.test(ch)) {
          if (started) inWS = true;
        } else {
          if (inWS) {
            normFlat += " ";
            normToFlat.push(fi - 1);
            inWS = false;
          }
          started = true;
          normFlat += ch;
          normToFlat.push(fi);
        }
      }

      let cursor = 0;
      for (const sentence of sentences) {
        const sentNorm = sentence.replace(/\s+/g, " ").trim();
        const sentStart = normFlat.indexOf(sentNorm, cursor);
        if (sentStart === -1) {
          sentenceRanges.push(null);
          continue;
        }
        const sentEnd = sentStart + sentNorm.length - 1;
        cursor = sentEnd + 1;

        const flatStart = normToFlat[sentStart];
        const flatEnd = normToFlat[sentEnd];

        // Find first and last valid charMap entries
        let startMap = null, endMap = null;
        for (let k = flatStart; k <= Math.min(flatEnd, charMap.length - 1); k++) {
          if (charMap[k]) { startMap = charMap[k]; break; }
        }
        for (let k = Math.min(flatEnd, charMap.length - 1); k >= flatStart; k--) {
          if (charMap[k]) { endMap = charMap[k]; break; }
        }

        if (!startMap || !endMap) {
          sentenceRanges.push(null);
          continue;
        }

        try {
          const r = new Range();
          r.setStart(textNodes[startMap.ni].node, startMap.off);
          r.setEnd(textNodes[endMap.ni].node, Math.min(endMap.off + 1, textNodes[endMap.ni].node.textContent.length));
          sentenceRanges.push(r);
        } catch {
          sentenceRanges.push(null);
        }
      }
    } catch (e) {
      slog(`Range build error: ${e.message}`);
    }
  }

  let scrollAnim = null;
  let userScrolling = false;
  let userScrollTimer = null;
  const USER_SCROLL_COOLDOWN = 3000;

  window.addEventListener("wheel", onUserScroll, { passive: true });
  window.addEventListener("touchmove", onUserScroll, { passive: true });

  function onUserScroll() {
    if (!active) return;
    userScrolling = true;
    if (scrollAnim) { cancelAnimationFrame(scrollAnim); scrollAnim = null; }
    clearTimeout(userScrollTimer);
    userScrollTimer = setTimeout(() => { userScrolling = false; }, USER_SCROLL_COOLDOWN);
  }

  function smoothScrollTo(targetY, duration = 600) {
    if (userScrolling) return;
    if (scrollAnim) cancelAnimationFrame(scrollAnim);
    const startY = window.scrollY;
    const dist = targetY - startY;
    if (Math.abs(dist) < 1) return;
    const startTime = performance.now();

    function step(now) {
      if (userScrolling) { scrollAnim = null; return; }
      const t = Math.min((now - startTime) / duration, 1);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      window.scrollTo(0, startY + dist * ease);
      if (t < 1) scrollAnim = requestAnimationFrame(step);
      else scrollAnim = null;
    }
    scrollAnim = requestAnimationFrame(step);
  }

  function setActiveSentence(index) {
    if (CSS.highlights) {
      CSS.highlights.delete("speak-blogs-active");
      const r = sentenceRanges[index];
      if (r) {
        CSS.highlights.set("speak-blogs-active", new Highlight(r));
        if (userScrolling) return;
        const rect = r.getBoundingClientRect();
        const vh = window.innerHeight;
        const topZone = vh * 0.25;
        const bottomZone = vh * 0.75;
        if (rect.top < topZone || rect.bottom > bottomZone) {
          const targetY = window.scrollY + rect.top - vh * 0.35;
          smoothScrollTo(targetY);
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
        if (!audio.buffers.has(target)) {
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

      overlay.onSaveNote = () => takeNote();

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
    noteTaking = false;
    currentPort = null;
    audio = null;
    overlay = null;
    savedSelectionRange = null;
  }

  // ── Text fragment URL ──

  function textFragmentForSentence(sentence) {
    const clean = sentence.replace(/\s+/g, " ").trim();
    if (!clean) return "";
    const words = clean.split(" ");
    if (words.length <= 8) {
      return encodeURIComponent(clean);
    }
    const start = words.slice(0, 4).join(" ");
    const end = words.slice(-4).join(" ");
    return `${encodeURIComponent(start)},${encodeURIComponent(end)}`;
  }

  // ── Keyboard shortcuts ──

  let noteTaking = false;

  async function takeNote() {
    if (noteTaking || !active || !audio || !overlay) return;
    noteTaking = true;
    const wasPlaying = audio.playing;
    if (wasPlaying) audio.pause();
    overlay.setPlayState(false);

    const sentence = allSentences[audio.currentIndex] || "";
    const userNote = await overlay.showNoteModal(sentence);

    noteTaking = false;
    if (userNote !== undefined) {
      const baseUrl = window.location.href.replace(/#.*$/, "");
      const fragment = textFragmentForSentence(sentence);
      const snippet = {
        sentence,
        note: userNote,
        url: baseUrl,
        highlightUrl: fragment ? `${baseUrl}#:~:text=${fragment}` : baseUrl,
        title: document.title,
        timestamp: new Date().toISOString(),
        sentenceIndex: audio.currentIndex,
      };
      chrome.runtime.sendMessage({ action: "save-snippet", snippet });
      overlay.showStatus("Note saved");
      slog(`Note saved for sentence ${audio.currentIndex}`);
    }

    if (wasPlaying) {
      audio.play();
      overlay.setPlayState(true);
    }
  }

  window.addEventListener("keydown", (e) => {
    if (noteTaking) return;
    if (!active || !audio || !overlay) return;

    if ((e.metaKey || e.ctrlKey) && e.code === "KeyJ") {
      e.preventDefault();
      e.stopImmediatePropagation();
      takeNote();
      return;
    }

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
  }, true);

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
