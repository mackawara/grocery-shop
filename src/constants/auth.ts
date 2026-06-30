// Vendor signup OTP tunables. Fixed product constants (not env-config): the OTP
// lives in Redis for this long, and a code may be attempted this many times
// before it is invalidated.
export const SIGNUP_OTP_TTL_SECONDS = 300;
export const SIGNUP_OTP_MAX_ATTEMPTS = 5;
