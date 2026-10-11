
const WS_URL = "ws://127.0.0.1:8765";
const MAX_RETRY_DELAY = 15000;

let socket: WebSocket | null = null;
let latestPlayback: unknown = null;
let retryDelay = 1000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function connect() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  socket = new WebSocket(WS_URL);

  socket.addEventListener("open", () => {
    retryDelay = 1000;

    if (latestPlayback) {
      socket?.send(JSON.stringify(latestPlayback));
    }
  });

  socket.addEventListener("close", (event) => {
    // 1008: the app rejected this extension's ID. Retrying quickly won't help.
    if (event.code === 1008) retryDelay = MAX_RETRY_DELAY;
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    socket?.close();
  });
}

function scheduleReconnect() {
  if (retryTimer) return;

  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryDelay);

  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!sender.url?.startsWith("https://music.youtube.com/")) {
    return;
  }

  if (message?.type !== "playback") return;

  latestPlayback = message;

  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  } else if (!retryTimer) {
    // Wait for the scheduled retry; otherwise every update (~750ms) retries while the app is closed.
    connect();
  }
});

connect();
