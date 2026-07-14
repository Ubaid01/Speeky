import jwt from "jsonwebtoken";
import crypto from "crypto";

// ── env accessors (read at call-time, after dotenv has run) ──────────────────

function getAccessSecret() {
  const s = process.env.JWT_ACCESS_SECRET;
  if (!s) throw new Error("JWT_ACCESS_SECRET not set");
  return s;
}

function getRefreshSecret() {
  const s = process.env.JWT_REFRESH_SECRET;
  if (!s) throw new Error("JWT_REFRESH_SECRET not set");
  return s;
}

function getResetSecret() {
  return process.env.JWT_RESET_SECRET ?? getAccessSecret();
}

function getAccessTTLMinutes() {
  return Number(process.env.ACCESS_TOKEN_TTL ?? 30);
}

function getRefreshTTLDays() {
  return Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7);
}

function getResetTTLMinutes() {
  return Number(process.env.RESET_TOKEN_TTL_MINUTES ?? 15);
}

// ── token helpers ────────────────────────────────────────────────────────────

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function signAccessToken(payload) {
  return jwt.sign(payload, getAccessSecret(), {
    expiresIn: `${getAccessTTLMinutes()}m`,
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, getAccessSecret());
}

export function signRefreshToken(payload) {
  return jwt.sign(payload, getRefreshSecret(), {
    expiresIn: `${getRefreshTTLDays()}d`,
  });
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, getRefreshSecret());
}

export function signResetToken(payload) {
  return jwt.sign(payload, getResetSecret(), {
    expiresIn: `${getResetTTLMinutes()}m`,
  });
}

export function verifyResetToken(token) {
  return jwt.verify(token, getResetSecret());
}

export function refreshExpiryDate() {
  const d = new Date();
  d.setDate(d.getDate() + getRefreshTTLDays());
  return d;
}

export function resetExpiryDate() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + getResetTTLMinutes());
  return d;
}

// ── cookie options (lazy functions — evaluated after dotenv loads) ────────────

export function getAccessCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: getAccessTTLMinutes() * 60 * 1000,
    path: "/",
  };
}

export function getRefreshCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    maxAge: getRefreshTTLDays() * 24 * 60 * 60 * 1000,
    path: "/api/auth",
  };
}
