self.addEventListener("push", (event) => {
  const payload = event.data ? event.data.json() : {};
  const title = payload.title || "App Release Center";
  const options = {
    body: payload.body || "Release command update.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: payload.data || { url: "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : "/";
  event.waitUntil(clients.openWindow(targetUrl));
});
