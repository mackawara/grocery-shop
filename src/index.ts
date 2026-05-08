import {startServer} from "./server";
import { logger } from "./services/logger";
import { RedisService } from "./services/redis";
import { CONFIG } from "./config";
import { connectDb } from "./services/database";


Promise.race([
  RedisService.getInstance().connect(),
  new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error("Failed to connect to Redis: Timeout exceeded"));
    }, CONFIG.REDIS_CONNECT_TIMEOUT);
  }),
])
.then(async () => {
    startServer();
    await connectDb();
  })
  .catch((error) => {
    logger.error(error);
    process.exit(1);
  });