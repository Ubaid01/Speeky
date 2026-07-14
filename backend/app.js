import "dotenv/config";
import cors from "cors";
import express from "express";
import cookieParser from "cookie-parser";
import AppError from "./utils/app_error.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import authRoutes from "./routes/auth_routes.js";

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.status(200).send("<h1>Speeky API is running!</h1>");
});

app.use("/api/auth", authRoutes);

app.all("/{*path}", (req, _res, next) => {
  next(new AppError(`Route not found: ${req.url}`, 404));
});

app.use(errorHandler);

export default app;
