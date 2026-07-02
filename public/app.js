let runDetailRefreshTimer = null;

(async () => {
  if (location.pathname.startsWith("/runs/")) {
    await initRunDetail();
    return;
  }

  await initPairing();
})();

async function initPairing() {
  const params = new URLSearchParams(location.search);
  const queryPairingId = params.get("pairing") || "";
  const queryPairingCode = params.get("code") || "";
  if (queryPairingId) localStorage.setItem("arcPairingId", queryPairingId);
  if (queryPairingCode) localStorage.setItem("arcPairingCode", queryPairingCode);

  const pairingId = queryPairingId || localStorage.getItem("arcPairingId") || "";
  const pairingCodeInput = document.querySelector("#pairing-code");
  const deviceNameInput = document.querySelector("#device-name");
  const status = document.querySelector("#status");
  const button = document.querySelector("#subscribe-button");

  pairingCodeInput.value =
    queryPairingCode || localStorage.getItem("arcPairingCode") || "";
  deviceNameInput.value = defaultDeviceName();

  const config = await fetchJson("/api/config");
  if (!config.vapidPublicKey) {
    setStatus("Web Push is not configured on this server.");
    button.disabled = true;
    return;
  }

  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    setStatus("This browser does not support Web Push.");
    button.disabled = true;
    return;
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      setStatus("Requesting notification permission...");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("Notification permission was not granted.");
        return;
      }

      await navigator.serviceWorker.register("/sw.js");
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
      });

      setStatus("Registering this phone...");
      await fetchJson("/api/push-subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairingId,
          pairingCode: pairingCodeInput.value.trim(),
          subscription: subscription.toJSON(),
          deviceName: deviceNameInput.value.trim(),
          platform: navigator.platform || "",
          browser: navigator.userAgent || "",
        }),
      });
      localStorage.removeItem("arcPairingId");
      localStorage.removeItem("arcPairingCode");
      setStatus("Linked. You can close this page.");
    } catch (error) {
      setStatus(error.message || String(error));
      button.disabled = false;
    }
  });

  function setStatus(message) {
    status.textContent = message;
  }
}

async function initRunDetail() {
  const main = document.querySelector("main");
  main.classList.add("detail");
  renderLoading(main);

  await fetchAndRenderRunDetail(main);
}

async function fetchAndRenderRunDetail(main) {
  if (runDetailRefreshTimer) {
    clearTimeout(runDetailRefreshTimer);
    runDetailRefreshTimer = null;
  }
  try {
    const runId = decodeURIComponent(location.pathname.split("/")[2] || "");
    if (!runId) throw new Error("Missing run id.");
    const response = await fetchJson(
      `/api/command-runs/${encodeURIComponent(runId)}${location.search}`,
    );
    renderRunDetail(main, response.run || {});
    if ((response.run || {}).status === "running") {
      runDetailRefreshTimer = setTimeout(
        () => fetchAndRenderRunDetail(main),
        5000,
      );
    }
  } catch (_) {
    renderUnavailable(main);
  }
}

function renderLoading(main) {
  main.replaceChildren(
    element("h1", "", "Command detail"),
    element("p", "", "Loading notification detail..."),
  );
}

function renderUnavailable(main) {
  main.replaceChildren(
    element("h1", "", "Command detail"),
    element("p", "", "This notification detail is no longer available."),
  );
}

function renderRunDetail(main, run) {
  const displayLabel =
    run.displayCommandLabel || run.commandLabel || run.command || "Release command";
  const title = element("h1", "", displayLabel);
  const badge = element(
    "div",
    `badge ${statusClass(run.status)}`,
    statusLabel(run.status),
  );
  const summary = element(
    "p",
    "",
    run.projectName || "App Release Center",
  );
  const grid = element("div", "detail-grid");

  appendField(grid, "Project", run.projectName || "App Release Center");
  appendField(grid, "Command", displayLabel);
  appendField(
    grid,
    "Exit code",
    run.exitCode === null || run.exitCode === undefined ? "-" : String(run.exitCode),
  );
  appendField(grid, "Duration", formatDuration(run.durationMs));
  appendField(grid, "Started", formatTime(run.startedAt));
  appendField(grid, "Finished", formatTime(run.finishedAt));
  appendField(grid, "Updated", formatTime(run.updatedAt));

  const children = [title, badge, summary, grid];
  if (Array.isArray(run.logTail) && run.logTail.length > 0) {
    const details = element("details", "log-block");
    details.open = run.logTail.length <= 6;
    const copyButton = element("button", "secondary-button", "Copy log tail");
    const copyStatus = element("div", "copy-status");
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(run.logTail.join("\n"));
        copyStatus.textContent = "Copied.";
      } catch (_) {
        copyStatus.textContent = "Copy is unavailable in this browser.";
      }
    });
    details.append(
      element("summary", "", "Log tail"),
      copyButton,
      copyStatus,
      element("pre", "", run.logTail.join("\n")),
    );
    children.push(details);
  }

  main.replaceChildren(...children);
}

function appendField(parent, label, value) {
  const field = element("div", "field");
  field.append(element("span", "", label), element("strong", "", value || "-"));
  parent.append(field);
}

function statusLabel(status) {
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  return "Running";
}

function statusClass(status) {
  if (status === "completed") return "success";
  if (status === "failed") return "failed";
  return "running";
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

function defaultDeviceName() {
  const platform = navigator.platform || "Phone";
  if (/iphone/i.test(navigator.userAgent)) return "iPhone";
  if (/android/i.test(navigator.userAgent)) return "Android phone";
  return platform;
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatDuration(value) {
  if (!Number.isInteger(value) || value < 0) return "-";
  if (value < 1000) return "<1s";
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
