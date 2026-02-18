const WS_URL = "ws://127.0.0.1:7890/ws";
const API_URL = "http://127.0.0.1:7890";

let ws = null;
let activePort = null;

function slog(msg) {
  const line = `[bg ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fetch(`${API_URL}/log?msg=${encodeURIComponent(line)}`).catch(() => {});
}

function connectWS() {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      slog("WebSocket connected");
      resolve();
    };
    ws.onerror = () => {
      slog("WebSocket error");
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      slog("WebSocket closed");
      ws = null;
    };
    ws.onmessage = (event) => {
      if (!activePort) return;
      if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data);
        const requestId = view.getUint32(0, true);
        const index = view.getUint32(4, true);
        const audioLen = view.getUint32(8, true);
        const audioBytes = new Uint8Array(event.data, 12, audioLen);
        // Chunk base64 encoding to avoid call stack overflow on large buffers
        let binary = "";
        const chunk = 8192;
        for (let i = 0; i < audioBytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, audioBytes.subarray(i, i + chunk));
        }
        const base64 = btoa(binary);
        activePort.postMessage({ type: "audio-chunk", requestId, index, base64 });
      } else {
        const msg = JSON.parse(event.data);
        activePort.postMessage(msg);
      }
    };
  });
}

async function ensureContentScripts(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: "ping" });
    if (response?.pong) return true;
  } catch (_) {}

  slog("Injecting content scripts");
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["overlay.css"] });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["ws.js", "audio.js", "overlay.js", "content.js"],
    });
    return true;
  } catch (err) {
    slog(`Injection failed: ${err.message}`);
    return false;
  }
}

async function triggerSpeak(tab) {
  if (!tab?.id) return;
  slog(`Triggering on tab ${tab.id}`);
  const ready = await ensureContentScripts(tab.id);
  if (!ready) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { action: "speak-selection" });
  } catch (err) {
    slog(`Send error: ${err.message}`);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "speak-blogs-tts") return;
  slog("Port connected");
  activePort = port;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "send-sentences" || msg.type === "cancel") {
      try {
        await connectWS();
        ws.send(JSON.stringify(msg));
        slog(`Forwarded ${msg.type}: reqId=${msg.requestId} startIdx=${msg.startIndex} count=${msg.sentences?.length}`);
      } catch (err) {
        slog(`WS error: ${err.message}`);
        port.postMessage({ type: "error", message: "Cannot connect to TTS server" });
      }
    }
  });

  port.onDisconnect.addListener(() => {
    slog("Port disconnected");
    activePort = null;
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  slog("Activated");
  await triggerSpeak(tab);
});

// ── Snippet saving ──

function snippetStorageKey(url) {
  return "snippets:" + url;
}

function slugify(title) {
  return title
    .replace(/^\(\d+\)\s*/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

function buildMarkdown(title, url, snippets) {
  let md = `# ${title}\n\n`;
  md += `> ${url}\n\n---\n\n`;
  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i];
    const time = new Date(s.timestamp).toLocaleString();
    const link = s.highlightUrl || s.url || url;
    md += `### [Snippet ${i + 1}](${link}) — ${time}\n\n`;
    md += `> ${s.sentence}\n\n`;
    if (s.note) md += `${s.note}\n\n`;
    md += `---\n\n`;
  }
  return md;
}

async function saveSnippet(snippet) {
  const key = snippetStorageKey(snippet.url);
  const data = await chrome.storage.local.get(key);
  const existing = data[key] || [];
  existing.push(snippet);
  await chrome.storage.local.set({ [key]: existing });

  const md = buildMarkdown(snippet.title, snippet.url, existing);
  const filename = `ReadFlow Snippets/${slugify(snippet.title)}.md`;

  const blob = new Blob([md], { type: "text/markdown" });
  const reader = new FileReader();
  reader.onload = () => {
    chrome.downloads.download({
      url: reader.result,
      filename,
      conflictAction: "overwrite",
      saveAs: false,
    }, (id) => {
      if (chrome.runtime.lastError) {
        slog(`Download error: ${chrome.runtime.lastError.message}`);
      } else {
        slog(`Snippet saved: ${filename} (${existing.length} total, download ${id})`);
      }
    });
  };
  reader.readAsDataURL(blob);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "save-snippet" && msg.snippet) {
    saveSnippet(msg.snippet);
    sendResponse({ ok: true });
  }
});

slog("Background service worker started");
