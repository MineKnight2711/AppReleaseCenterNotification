self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : {};
  const title = payload.title || "App Release Center";
  const options = {
    body: payload.body || "Release command update.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: payload.tag || (payload.data && payload.data.runId) || undefined,
    renotify: payload.renotify === true,
    timestamp: payload.timestamp || Date.now(),
    data: payload.data || { url: "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : "/";
  event.waitUntil(openOrFocus(targetUrl));
});

async function openOrFocus(targetUrl) {
  const url = new URL(targetUrl, self.location.origin).href;
  const windows = await clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of windows) {
    if (client.url === url && "focus" in client) {
      return client.focus();
    }
  }
  return clients.openWindow(url);
}
