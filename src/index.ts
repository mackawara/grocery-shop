import express, { Request, Response } from "express";
import { logger } from "./services/logger";
import { CONFIG } from "./config";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());


app.get("/", (req: Request, res: Response) => {
  res.json({
    message: "Server running and working",
  });
});

const startServer = () => {
    try{
        app.listen(CONFIG.PORT, () => {
            logger.info(`Server is running on port ${CONFIG.PORT}`);
        });
    } catch (error) {
        logger.error("Error starting server: ", error);
        process.exit(1);
    }
};

startServer();