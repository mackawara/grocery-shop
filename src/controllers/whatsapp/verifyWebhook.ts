import express, { Request, Response } from "express";
import { CONFIG } from "../../config";

interface payload {
  "hub.mode": string;
  "hub.verify_token": string;
  "hub.challenge": string;
}
export const verifyWebhookToken =
  () =>
  async (request: Request<{ Querystring: payload }>, response: Response) => {
    const verifyToken = CONFIG.WHATSAPP_WEBHOOK_VERIFICATION_TOKEN;
    const mode = request.query["hub.mode"];
    const token = request.query["hub.verify_token"];
    const challenge = request.query["hub.challenge"];
    // Check if a token and mode were sent
    if (mode && token) {
      // Check the mode and token sent are correct
      if (mode === "subscribe" && token === verifyToken) {
        return response.status(200).send(challenge);
      } else {
        return response.status(403).send({
          success: false,
          message: "Invalid request: Invalid mode or token",
        });
      }
    } else {
      return response.status(403).send({
        success: false,
        message: "Invalid request: Missing mode or token",
      });
    }
  };