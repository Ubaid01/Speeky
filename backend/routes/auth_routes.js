import { Router } from "express";
import {
  signup,
  login,
  refresh,
  logout,
  me,
  forgotPassword,
  resetPassword,
} from "../controllers/auth_controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

// Public routes
router.post("/signup", signup);
router.post("/login", login);
router.post("/refresh", refresh);
router.post("/logout", logout);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

// Protected routes
router.get("/me", requireAuth, me);

export default router;
