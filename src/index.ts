#!/usr/bin/env node

import "dotenv/config";

import { logger } from "./logger.js";
import { startApp } from "./main.js";

startApp().catch((error) => {
  logger.fatal({ err: error }, "Fatal error");
  process.exit(1);
});
