import { config } from "./config.js";
import * as gcal from "./calendar/google.js";
import { log } from "./logger.js";
import { createApp } from "./server.js";
import { startScheduler } from "./jobs/scheduler.js";

const app = createApp();
app.listen(config.PORT, () => {
  log.info(`Server listening on :${config.PORT} (public URL ${config.PUBLIC_URL})`);
  if (!gcal.isAuthorized()) {
    log.warn(`Google Calendar not connected. Open ${config.PUBLIC_URL}/auth/google in a browser to connect ${config.USER_NAME}'s account.`);
  } else {
    log.info("Google Calendar connected");
  }
  startScheduler();
});
