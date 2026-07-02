const { createFirestoreNotificationStore, hasFirestoreConfig } = require("./firestore_store");
const { JsonNotificationStore } = require("./store");

function createNotificationStore(config) {
  if (hasFirestoreConfig(config)) {
    return createFirestoreNotificationStore(config);
  }

  return new JsonNotificationStore(
    config.STORE_FILE || "./data/notifications-store.json",
  );
}

module.exports = {
  createNotificationStore,
};
