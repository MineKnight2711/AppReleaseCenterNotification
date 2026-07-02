require("dotenv").config();

const { createApp } = require("./app");

const port = Number.parseInt(process.env.PORT || "8080", 10);
const app = createApp();

app.listen(port, () => {
  console.log(`Notification server listening on port ${port}`);
});
