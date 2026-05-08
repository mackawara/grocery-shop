import mongoose from "mongoose";
import { CONFIG } from "../config";
import { logger } from "./logger";


export const connectDb = (async () => {
  try {

    const mongoString = 'mongodb+srv://{MONGODB_USERNAME}:{MONGODB_PASSWORD}@{MONGODB_HOST}'

    const connectionString =
      `mongodb+srv://${CONFIG.MONGODB_USERNAME}:${CONFIG.MONGODB_PASSWORD}@${CONFIG.MONGODB_HOST}`;
    logger.info(`[MONGOOSE]: Connecting: ${mongoString} `);

    const _db = await mongoose.connect(connectionString);
    logger.info("[MONGOOSE] Database connected successfully");
    if (process.env.DB_DEBUG === "true") {
      logger.info(
        "Enabling mongoose debug mode. Disable it by not setting DB_DEBUG in your .env",
      );
      mongoose.set("debug", true);
    }
    return _db;
  } catch (error) {
    logger.error("Failed Database Connection", error);
    process.exit(1);
  }
});


