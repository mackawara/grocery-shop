import { redisClient } from "../../services/redis";
import { logger } from "../../services/logger";

const TAG = "REDIS_CONTROLLER";
const DEFAULT_EXPIRY = 180;

type SetResult = { success: true } | { success: false; error: string };

export const setRedisHashKeyValuePair = async ({
  hashName,
  key,
  value,
  expiry,
}: {
  hashName: string;
  key: string;
  value: string;
  expiry?: number;
}): Promise<SetResult> => {
  if (!hashName || !key || !value) {
    return { success: false, error: "hashName, key, and value are required" };
  }

  try {
    await redisClient.hSet(hashName, key, value);
    await redisClient.expire(hashName, expiry ?? DEFAULT_EXPIRY);
    logger.silly(`[${TAG}] Set ${hashName}:${key}`);
    return { success: true };
  } catch (error) {
    logger.error(`[${TAG}] Error setting ${hashName}:${key}: ${error}`);
    return { success: false, error: String(error) };
  }
};

export const getRedisHashValue = async (
  hashName: string,
  key: string,
): Promise<string | null> => {
  if (!hashName || !key) {
    logger.warn(`[${TAG}] getRedisHashValue: hashName and key are required`);
    return null;
  }

  try {
    return await redisClient.hGet(hashName, key) ?? null;
  } catch (error) {
    logger.error(`[${TAG}] Error getting ${hashName}:${key}: ${error}`);
    return null;
  }
};

export const getRedisHash = async (
  hashName: string,
): Promise<Record<string, string> | null> => {
  if (!hashName) {
    logger.warn(`[${TAG}] getRedisHash: hashName is required`);
    return null;
  }

  try {
    const result = await redisClient.hGetAll(hashName);
    if (!result || Object.keys(result).length === 0) return null;
    return result;
  } catch (error) {
    logger.error(`[${TAG}] Error getting hash ${hashName}: ${error}`);
    return null;
  }
};

export const deleteRedisHashField = async (
  hashName: string,
  key: string,
): Promise<SetResult> => {
  if (!hashName || !key) {
    return { success: false, error: "hashName and key are required" };
  }

  try {
    await redisClient.hDel(hashName, key);
    logger.silly(`[${TAG}] Deleted field ${hashName}:${key}`);
    return { success: true };
  } catch (error) {
    logger.error(`[${TAG}] Error deleting ${hashName}:${key}: ${error}`);
    return { success: false, error: String(error) };
  }
};

export const isMessageProcessed = async (
  key: string,
  ttlSeconds: number,
): Promise<boolean> => {
  try {
    const result = await redisClient.set(key, "1", { NX: true, EX: ttlSeconds });
    return result === null; // null means key already existed → already processed
  } catch (error) {
    logger.error(`[${TAG}] Error in isMessageProcessed for ${key}: ${error}`);
    return false;
  }
};

export const deleteRedisHash = async (hashName: string): Promise<SetResult> => {
  if (!hashName) {
    return { success: false, error: "hashName is required" };
  }

  try {
    await redisClient.del(hashName);
    logger.silly(`[${TAG}] Deleted hash ${hashName}`);
    return { success: true };
  } catch (error) {
    logger.error(`[${TAG}] Error deleting hash ${hashName}: ${error}`);
    return { success: false, error: String(error) };
  }
};
