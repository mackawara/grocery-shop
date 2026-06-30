import { startServer } from './server.ts';
import { logger } from './services/logger.ts';
import { RedisService } from './services/redis.ts';
import { CONFIG } from './config.ts';
import { connectDb } from './services/database.ts';

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
