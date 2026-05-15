import * as dotenv from "dotenv";
import path from "path";

import { logger } from "./services/logger";
dotenv.config({ path: path.join(__dirname, "../.env") });

const TAG = "CONFIG";

const isLocal = process.env.APP_ENV?.toUpperCase() === "LOCAL";

const mandatoryEnvironmentConstants = [
  "APP_ENV",
  "PORT",
  "REDIS_HOST_PORT",
  "REDIS_HOST",
  "WHATSAPP_WEBHOOK_VERIFICATION_TOKEN",
  "MONGODB_USERNAME",
  "MONGODB_PASSWORD",
  "MONGODB_HOST",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_SYSTEM_TOKEN",
  ...(isLocal ? ["NGROK_DOMAIN"] : []),
];

const missingEnvironmentVariables = mandatoryEnvironmentConstants.filter(
  (constant) => !process.env[constant],
);

if (missingEnvironmentVariables.length > 0) {
  const constantsString = JSON.stringify(missingEnvironmentVariables);

  logger.info(
    `[${TAG}] Environment variable(s) ${constantsString.substring(
      1,
      constantsString.length - 1,
    )} required. If running on local server, create a .env file in the root folder and define them in that file like: 
      
  MONGODB_USERNAME=username
  MONGODB_PASSWORD=password
  MONGODB_DATABASE_HOST=cluster_path/database_name
  ...
  `,
  );

  process.exit(1);
}

export const CONFIG = {
  IS_LOCAL_ENVIRONMENT: isLocal,
  PORT: parseInt(process.env.PORT || "0", 10) || 4000,
  REDIS_HOST_PORT: process.env.REDIS_HOST_PORT
    ? parseInt(process.env.REDIS_HOST_PORT)
    : 6379,
  REDIS_HOST: process.env.REDIS_HOST || "localhost",
  REDIS_CONNECT_TIMEOUT: parseInt(
    process.env.REDIS_CONNECT_TIMEOUT || "0",
    10,
  ) || 90000,
  WHATSAPP_WEBHOOK_VERIFICATION_TOKEN: process.env.WHATSAPP_WEBHOOK_VERIFICATION_TOKEN || "",
  MONGODB_USERNAME: process.env.MONGODB_USERNAME || "",
  MONGODB_PASSWORD: process.env.MONGODB_PASSWORD || "",
  MONGODB_HOST: process.env.MONGODB_HOST || "",
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  WHATSAPP_SYSTEM_TOKEN: process.env.WHATSAPP_SYSTEM_TOKEN || "",
  NGROK_DOMAIN: process.env.NGROK_DOMAIN || "",
  SHOP_NAME: process.env.SHOP_NAME || "",
  SHOP_ADDRESS: process.env.SHOP_ADDRESS || "",
};
logger.warn(
  `[${TAG}] Running in ${CONFIG.IS_LOCAL_ENVIRONMENT ? "LOCAL" : "PRODUCTION"} environment`,
);
 