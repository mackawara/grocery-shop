import { redisClient } from '../../services/redis';
import { logger } from '../../services/logger';
import { tenantKey } from '../../utils/tenantKey';

const TAG = 'REDIS_CONTROLLER';
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
    return { success: false, error: 'hashName, key, and value are required' };
  }

  const scopedHash = tenantKey(hashName);
  try {
    await redisClient.hSet(scopedHash, key, value);
    await redisClient.expire(scopedHash, expiry ?? DEFAULT_EXPIRY);
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

  const scopedHash = tenantKey(hashName);
  try {
    return await redisClient.hGet(scopedHash, key) ?? null;
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

  const scopedHash = tenantKey(hashName);
  try {
    const result = await redisClient.hGetAll(scopedHash);
    if (!result || Object.keys(result).length === 0) {
      return null;
    }
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
    return { success: false, error: 'hashName and key are required' };
  }

  const scopedHash = tenantKey(hashName);
  try {
    await redisClient.hDel(scopedHash, key);
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
  const scopedKey = tenantKey(key);
  try {
    const result = await redisClient.set(scopedKey, '1', { NX: true, EX: ttlSeconds });
    return result === null;
  } catch (error) {
    // Fail closed: if we can't confirm dedup (e.g. Redis outage), treat the
    // message as already processed so it is skipped rather than reprocessed.
    // Returning false here would let every redelivery through during an outage
    // and create duplicate orders.
    logger.error(`[${TAG}] Error in isMessageProcessed for ${key}, failing closed (treating as processed): ${error}`);
    return true;
  }
};

export const deleteRedisHash = async (hashName: string): Promise<SetResult> => {
  if (!hashName) {
    return { success: false, error: 'hashName is required' };
  }

  const scopedHash = tenantKey(hashName);
  try {
    await redisClient.del(scopedHash);
    logger.silly(`[${TAG}] Deleted hash ${hashName}`);
    return { success: true };
  } catch (error) {
    logger.error(`[${TAG}] Error deleting hash ${hashName}: ${error}`);
    return { success: false, error: String(error) };
  }
};
