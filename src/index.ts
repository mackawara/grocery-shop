import { startServer } from './server.js';
import { logger } from './services/logger.js';
import { RedisService } from './services/redis.js';
import { CONFIG } from './config.js';
import { connectDb } from './services/database.js';

Promise.race([
  RedisService.getInstance().connect(),
  new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error('Failed to connect to Redis: Timeout exceeded'));
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
