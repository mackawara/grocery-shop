import express, { Request, Response } from "express";
import { logger } from "./services/logger";
import { CONFIG } from "./config";
import whatsappRoutes from "./routes/whatsapp.routes";
import cors from "cors";
import helmet from "helmet";

const app = express();
app.use(cors());
app.use(express.json());
app.use(helmet());

//routes
app.use("/whatsapp", whatsappRoutes);


app.get("/", (req: Request, res: Response) => {
  res.json({
    message: "Server running and working",
  });
});

export const startServer = () => {
    app.listen(CONFIG.PORT, () => {
        logger.info(`Server is running on port ${CONFIG.PORT}`);
    });
};

export default app;
