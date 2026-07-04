import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { redisClient } from './redis.ts';
import { globalKey } from '../utils/tenantKey.ts';
import { SIGNUP_OTP_TTL_SECONDS, SIGNUP_OTP_MAX_ATTEMPTS } from '../constants/auth.ts';
import { logger } from './logger.ts';
import { CONFIG } from '../config.ts';

const TAG = '[SIGNUP-OTP]';

// Vendor-signup OTP, kept in Redis under globalKey (signup is pre-tenant, so
// there is no tenant context to scope to). Two security properties matter here:
// (1) we store only a SHA-256 hash of the code, never the code itself, so a
// Redis dump can't reveal live OTPs; (2) verification is attempt-capped and
// constant-time. The plaintext code is returned once from generate (so the
// caller can send it over WhatsApp) and never logged or persisted.
//
// Callers must pass an already-normalized phone (digits only) so the Redis keys
// and the stored VendorUser.phoneNumber stay consistent.

const otpKey = (phone: string): string => globalKey(`signup-otp:${phone}`);
const attemptsKey = (phone: string): string => globalKey(`signup-otp-attempts:${phone}`);
const claimKey = (phone: string): string => globalKey(`phone-claim:${phone}`);

const hashOtp = (phone: string, code: string): string =>
  createHash('sha256').update(`${phone}:${code}`).digest('hex');

// Constant-time hex comparison. Equal-length hex strings let us compare the
// raw buffers directly; timingSafeEqual throws on length mismatch, so guard it.
const safeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
};

export enum OtpVerifyResult {
  OK = 'ok',
  INVALID = 'invalid',
  EXPIRED = 'expired',
  TOO_MANY_ATTEMPTS = 'too_many_attempts',
}

// Generate a 6-digit code, store its hash (TTL), reset the attempt counter, and
// return the plaintext code for the caller to deliver. Overwrites any existing
// code for this phone (a re-request invalidates the previous one).
export const generateSignupOtp = async (phone: string): Promise<string> => {
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const ttl = SIGNUP_OTP_TTL_SECONDS;
  await redisClient.set(otpKey(phone), hashOtp(phone, code), { EX: ttl });
  await redisClient.del(attemptsKey(phone));
  logger.info(`${TAG} issued OTP for ${maskPhone(phone)} (ttl ${ttl}s)`);
  if (CONFIG.IS_LOCAL_ENVIRONMENT) {
    logger.info(`${TAG} OTP for ${maskPhone(phone)} is ${code}`);
  }
  return code;
};

// Verify a submitted code. Counts each attempt and fails closed once the cap is
// reached. On success, clears both the code and the attempt counter.
export const verifySignupOtp = async (
  phone: string,
  code: string,
): Promise<OtpVerifyResult> => {
  const stored = await redisClient.get(otpKey(phone));
  if (!stored) {
    return OtpVerifyResult.EXPIRED;
  }

  const attempts = await redisClient.incr(attemptsKey(phone));
  if (attempts === 1) {
    // Pin the counter to the same lifetime as the code so it can't outlive it.
    await redisClient.expire(attemptsKey(phone), SIGNUP_OTP_TTL_SECONDS);
  }
  if (attempts > SIGNUP_OTP_MAX_ATTEMPTS) {
    await redisClient.del(otpKey(phone));
    logger.warn(`${TAG} too many OTP attempts for ${maskPhone(phone)} — invalidated`);
    return OtpVerifyResult.TOO_MANY_ATTEMPTS;
  }

  if (!safeEqualHex(stored, hashOtp(phone, code))) {
    return OtpVerifyResult.INVALID;
  }

  await redisClient.del(otpKey(phone));
  await redisClient.del(attemptsKey(phone));
  return OtpVerifyResult.OK;
};

// Serialize concurrent signups for the same phone: SET NX over the OTP window.
// Returns true if the claim was acquired, false if another signup holds it.
// This closes the check-then-insert race on global phone uniqueness; the
// persisted VendorUser row is the permanent guard once provisioning completes.
export const claimPhoneForSignup = async (phone: string): Promise<boolean> => {
  const acquired = await redisClient.set(claimKey(phone), '1', {
    NX: true,
    EX: SIGNUP_OTP_TTL_SECONDS,
  });
  return acquired === 'OK';
};

export const releasePhoneClaim = async (phone: string): Promise<void> => {
  await redisClient.del(claimKey(phone));
};

// Mask all but the last 4 digits for logs — never log a full phone or the code.
const maskPhone = (phone: string): string =>
  phone.length <= 4 ? '****' : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
