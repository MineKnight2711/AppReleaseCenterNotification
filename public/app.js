(async () => {
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

      const registration = await navigator.serviceWorker.register("/sw.js");
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
})();

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
