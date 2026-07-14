import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import {
  signAccessToken,
  signRefreshToken,
  signResetToken,
  verifyRefreshToken,
  verifyResetToken,
  refreshExpiryDate,
  resetExpiryDate,
  getAccessCookieOptions,
  getRefreshCookieOptions,
  hashToken,
} from "../utils/jwt.js";
import { sendPasswordResetEmail } from "../utils/email.js";

// ── Validation schemas ────────────────────────────────────────────────────────

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  // .regex(
  //   /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).+$/,
  //   "Password must contain uppercase, lowercase, number, and special character.",
  // ),
  name: z.string().min(1).max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const forgotSchema = z.object({
  email: z.string().email(),
});

const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
  // .regex(
  //   /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&]).+$/,
  //   "Password must contain uppercase, lowercase, number, and special character.",
  // ),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function issueTokens(res, userId) {
  const accessToken = signAccessToken({ sub: userId });
  const refreshToken = signRefreshToken({ sub: userId });

  await prisma.refreshToken.create({
    data: {
      tokenHash: hashToken(refreshToken),
      userId,
      expiresAt: refreshExpiryDate(),
    },
  });

  res.cookie("access_token", accessToken, getAccessCookieOptions());
  res.cookie("refresh_token", refreshToken, getRefreshCookieOptions());
}

// ── Controllers ───────────────────────────────────────────────────────────────

export async function signup(req, res) {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email, password, name } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const hashed = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { email, password: hashed, name },
  });

  await issueTokens(res, user.id);
  return res.status(201).json({ user: { id: user.id, email: user.email, name: user.name } });
}

export async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });

  // Constant-time: dummy hash prevents timing attack)
  const dummyHash = "$2b$12$invalidhashpaddingthatisexactly53charslongXXXXXXXXX";
  const valid = user
    ? await bcrypt.compare(password, user.password)
    : await bcrypt.compare(password, dummyHash).then(() => false);

  if (!user || !valid) return res.status(401).json({ error: "Invalid credentials" });

  await issueTokens(res, user.id);
  return res.json({
    user: { id: user.id, email: user.email, name: user.name },
  });
}

export async function refresh(req, res) {
  const token = req.cookies?.refresh_token;
  if (!token) return res.status(401).json({ error: "No refresh token" });

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }

  const tokenHash = hashToken(token);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!stored || stored.revoked || stored.expiresAt < new Date()) {
    // Possible token reuse — revoke all tokens for this user
    if (stored) {
      await prisma.refreshToken.updateMany({
        where: { userId: stored.userId },
        data: { revoked: true },
      });
    }
    return res.status(401).json({ error: "Refresh token revoked or expired" });
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) return res.status(401).json({ error: "User not found" });

  // Rotate: revoke old, issue new
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revoked: true },
  });

  await issueTokens(res, user.id);
  return res.json({
    user: { id: user.id, email: user.email, name: user.name },
  });
}

export async function logout(req, res) {
  const token = req.cookies?.refresh_token;
  if (token) {
    const tokenHash = hashToken(token);
    await prisma.refreshToken
      .updateMany({ where: { tokenHash }, data: { revoked: true } })
      .catch(() => {});
  }

  const accessOpts = getAccessCookieOptions();
  const refreshOpts = getRefreshCookieOptions();

  res.clearCookie("access_token", { ...accessOpts, maxAge: undefined });
  res.clearCookie("refresh_token", { ...refreshOpts, maxAge: undefined });
  return res.status(204).send();
}

export async function me(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, email: true, name: true, createdAt: true },
  });
  if (!user) return res.status(404).json({ error: "User not found" });
  return res.json({ user });
}

export async function forgotPassword(req, res) {
  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email } = parsed.data;

  // Always respond 200 — never reveal whether email exists (prevents enumeration)
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user)
    return res
      .status(200)
      .json({ message: "If that email is registered, a reset link has been sent." });

  // Invalidate any existing reset tokens for this user
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const rawToken = signResetToken({ sub: user.id });
  await prisma.passwordResetToken.create({
    data: {
      tokenHash: hashToken(rawToken),
      userId: user.id,
      expiresAt: resetExpiryDate(),
    },
  });

  const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";
  const resetUrl = `${clientOrigin}/reset-password?token=${rawToken}`;

  await sendPasswordResetEmail(user.email, resetUrl);

  return res
    .status(200)
    .json({ message: "If that email is registered, a reset link has been sent." });
}

export async function resetPassword(req, res) {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { token, password } = parsed.data;

  let payload;
  try {
    payload = verifyResetToken(token);
  } catch {
    return res.status(400).json({ error: "Invalid or expired reset token" });
  }

  const tokenHash = hashToken(token);
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });

  if (!stored || stored.userId !== payload.sub || stored.usedAt || stored.expiresAt < new Date()) {
    return res.status(400).json({ error: "Reset token is invalid or has already been used" });
  }

  const hashed = await bcrypt.hash(password, 12);

  // Transaction: mark token used + update password + revoke all refresh tokens
  await prisma.$transaction([
    prisma.passwordResetToken.update({
      where: { id: stored.id },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: payload.sub },
      data: { password: hashed },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: payload.sub },
      data: { revoked: true },
    }),
  ]);

  return res.status(200).json({ message: "Password reset successful. Please log in." });
}
