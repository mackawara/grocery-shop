import {startServer} from "./server";
import { logger } from "./services/logger";

try{
    startServer();
} catch(error) {
    logger.error("Error starting server: ", error);
    process.exit(1);
};