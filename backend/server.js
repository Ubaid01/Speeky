import app from "./app.js";

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

const PORT = process.env.PORT ?? 8000;

const server = app.listen(PORT, () =>
  console.log(`Speeky-AI backend listening on port ${PORT}`),
);

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  server.close(() => process.exit(1));
});
