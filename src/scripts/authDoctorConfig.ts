// The doctor must report missing settings without importing application config,
// which exits during module initialization when unrelated services are unset.
export interface AuthDoctorConfig {
  AUTHENTIK_ISSUER: string;
  AUTHENTIK_BASE_URL: string;
  AUTHENTIK_CLIENT_ID: string;
  AUTHENTIK_CLIENT_SECRET: string;
  AUTHENTIK_ADMIN_TOKEN: string;
  AUTHENTIK_RECOVERY_EMAIL_STAGE: string;
  AUTH_REDIRECT_URI: string;
  AUTHENTIK_POST_LOGOUT_REDIRECT: string;
}

export const readAuthDoctorConfig = (env: NodeJS.ProcessEnv): AuthDoctorConfig => {
  const isLocal = env.APP_ENV?.toUpperCase() === 'LOCAL';
  const publicBaseUrl =
    env.PUBLIC_BASE_URL || (isLocal && env.NGROK_DOMAIN ? `https://${env.NGROK_DOMAIN}` : '');

  return {
    AUTHENTIK_ISSUER: env.AUTHENTIK_ISSUER || '',
    AUTHENTIK_BASE_URL: env.AUTHENTIK_BASE_URL || '',
    AUTHENTIK_CLIENT_ID: env.AUTHENTIK_CLIENT_ID || '',
    AUTHENTIK_CLIENT_SECRET: env.AUTHENTIK_CLIENT_SECRET || '',
    AUTHENTIK_ADMIN_TOKEN: env.AUTHENTIK_ADMIN_TOKEN || '',
    AUTHENTIK_RECOVERY_EMAIL_STAGE: env.AUTHENTIK_RECOVERY_EMAIL_STAGE || '',
    AUTH_REDIRECT_URI:
      env.AUTH_REDIRECT_URI || (publicBaseUrl ? `${publicBaseUrl}/auth/callback` : ''),
    AUTHENTIK_POST_LOGOUT_REDIRECT: env.AUTHENTIK_POST_LOGOUT_REDIRECT || env.DASHBOARD_URL || '',
  };
};
