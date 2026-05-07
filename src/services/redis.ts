import { createClient, RedisClientType } from "redis";

import { CONFIG } from "../config";
import { logger } from "./logger";

const TAG = "REDIS";

export class RedisService {
  private static instance: RedisService;
  private client: RedisClientType;
  private isConnected: boolean = false;

  private constructor() {
    this.client = createClient({
      socket: {
        port: CONFIG.REDIS_HOST_PORT,
        host: CONFIG.REDIS_HOST,
        connectTimeout: CONFIG.REDIS_CONNECT_TIMEOUT,
        keepAlive: true,
        reconnectStrategy: (retries, error) => {
          logger.warn(
            `[${TAG}] Redis attempt #${retries} reconnect failed: ${error}`,
          );
          if (retries > 10) {
            logger.error(`[${TAG}] Redis reconnect failed, shutting down`);
            process.exit(1);
          }
          return 6000 + retries * 1000;
        },
      },
    });

    this.setupListeners();
  }

  private setupListeners() {
    this.client.on("connect", () => {
      this.isConnected = true;
      logger.info(
        `[${TAG}] Connected to Redis. HOST: ${CONFIG.REDIS_HOST}. PORT: ${CONFIG.REDIS_HOST_PORT}`,
      );
      if (CONFIG.IS_LOCAL_ENVIRONMENT) {
        this.flushDB();
      }
    });

    this.client.on("reconnecting", () => {
      logger.info(
        `[${TAG}] Reconnecting to Redis. HOST: ${CONFIG.REDIS_HOST}. PORT: ${CONFIG.REDIS_HOST_PORT}`,
      );
    });

    this.client.on("error", (err) => {
      logger.warn(`[${TAG}] Error connecting to Redis: ${err}`);
    });

    this.client.on("end", () => {
      this.isConnected = false;
      logger.warn(`[${TAG}] Redis connection ended`);
    });
  }

  public static getInstance(): RedisService {
    if (!RedisService.instance) {
      RedisService.instance = new RedisService();
    }
    return RedisService.instance;
  }

  public async connect() {
    if (!this.isConnected) {
      logger.info(
        `[${TAG}] Connecting to Redis. HOST: ${CONFIG.REDIS_HOST}. PORT: ${CONFIG.REDIS_HOST_PORT}`,
      );
      await this.client.connect();
    }
  }

  public getClient(): RedisClientType {
    return this.client;
  }

  private async flushDB() {
    if (CONFIG.IS_LOCAL_ENVIRONMENT) {
      try {
        await this.client.flushDb();
        logger.info(`[${TAG}] Redis database flushed`);
      } catch (err) {
        logger.error(`[${TAG}] Failed to flush Redis DB: ${err}`);
      }
    }
  }
}

export const redisClient = RedisService.getInstance().getClient();
