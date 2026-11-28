const DEFAULT_URL = "ws://127.0.0.1:47123/pi-browser";
const input = document.getElementById("url");
const status = document.getElementById("status");
const connection = document.getElementById("connection");

function transportLabel(bridgeStatus) {
  if (bridgeStatus.transport === "native") return " native messaging";
  if (bridgeStatus.transport === "websocket") return " websocket fallback";
  return "";
}

function renderStatus(bridgeStatus) {
  if (!bridgeStatus) {
    connection.textContent = "No connection attempt yet.";
    return;
  }
  const time = new Date(bridgeStatus.at).toLocaleTimeString();
  const via = transportLabel(bridgeStatus);
  if (bridgeStatus.state === "connected") {
    connection.textContent = `Connected to PI-Desktop via${via} (${time}).`;
  } else if (bridgeStatus.state === "connecting") {
    connection.textContent = `Connecting to ${bridgeStatus.url || "PI-Desktop"} …`;
  } else if (bridgeStatus.state === "reconnecting") {
    connection.textContent = `Reconnecting (${bridgeStatus.reason || "connection lost"}) (${time}).`;
  } else {
    const reason = bridgeStatus.reason || (bridgeStatus.code ? `close code ${bridgeStatus.code}` : "connection failed");
    connection.textContent = `Disconnected: ${reason}. Retrying automatically (${time}).`;
  }
}

chrome.storage.local.get({ bridgeUrl: DEFAULT_URL, bridgeStatus: null }).then(({ bridgeUrl, bridgeStatus }) => {
  input.value = bridgeUrl;
  renderStatus(bridgeStatus);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.bridgeStatus) renderStatus(changes.bridgeStatus.newValue);
});

document.getElementById("save").addEventListener("click", async () => {
  const bridgeUrl = input.value.trim() || DEFAULT_URL;
  if (!/[?&]token=/.test(bridgeUrl)) {
    status.textContent = "missing token — copy the full URL from PI-Desktop Settings → Browser backend";
    return;
  }
  await chrome.storage.local.set({ bridgeUrl });
  status.textContent = "saved";
  await chrome.runtime.sendMessage({ type: "reconnect" });
});
