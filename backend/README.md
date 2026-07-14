# Speeky AI — Backend

Express.js REST API for the Speeky AI application. Handles authentication, JWT session management, and password reset flows. Uses Prisma ORM with PostgreSQL (Prisma Postgres cloud or local Docker).

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js (ESM — `"type": "module"`) |
| Framework | Express 5 |
| ORM | Prisma 7 + `@prisma/adapter-pg` (driver adapter) |
| Database | PostgreSQL (Prisma Postgres cloud or local Docker) |
| Auth | JWT (access + refresh tokens via HTTP-only cookies) |
| Validation | Zod 4 |
| Password hashing | bcryptjs (cost 12) |
| Email | Nodemailer (Ethereal fake SMTP in dev, real SMTP in prod) |

---

## Project Structure

```
backend/
├── app.js                  # Express app setup (middleware, routes)
├── server.js               # HTTP server entry point
├── prisma.config.ts        # Prisma CLI config (schema + migrations path)
│
├── controllers/
│   └── auth_controller.js  # signup, login, refresh, logout, me, forgotPassword, resetPassword
│
├── routes/
│   └── auth_routes.js      # /api/auth/* route definitions
│
├── middlewares/
│   ├── auth.middleware.js  # requireAuth — verifies access_token cookie, sets req.userId
│   └── errorHandler.js     # Global Express error handler
│
├── lib/
│   └── prisma.js           # Singleton PrismaClient with PrismaPg driver adapter
│
├── utils/
│   ├── app_error.js        # AppError class (operational errors) + catchAsync wrapper
│   ├── jwt.js              # Token sign/verify helpers, cookie option factories, hashToken
│   └── email.js            # sendPasswordResetEmail — Ethereal (dev) / SMTP (prod)
│
└── prisma/
    ├── schema.prisma        # Data models: User, RefreshToken, PasswordResetToken
    └── migrations/          # Prisma migration history
```

---

## Environment Variables

Copy `.env.example` (or see below) to `.env` and fill in values.

```dotenv
# ── Database ──────────────────────────────────────────────────────────────────
# Prisma Postgres cloud URL (from Prisma console / create-db)
DATABASE_URL="postgres://..."

# ── Server ────────────────────────────────────────────────────────────────────
PORT=8000
NODE_ENV=development                    # development | production
CLIENT_ORIGIN=http://localhost:5173     # Frontend URL (CORS + password reset link base)

# ── JWT secrets (generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
JWT_ACCESS_SECRET=<64-char hex>
JWT_REFRESH_SECRET=<64-char hex>
# JWT_RESET_SECRET=<64-char hex>       # Optional; falls back to JWT_ACCESS_SECRET

# ── Token TTLs ────────────────────────────────────────────────────────────────
ACCESS_TOKEN_TTL=30          # minutes
REFRESH_TOKEN_TTL_DAYS=7     # days
RESET_TOKEN_TTL_MINUTES=15   # minutes

# ── SMTP (optional in dev — Ethereal fake SMTP used automatically) ─────────────
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_USER=your@email.com
# SMTP_PASS=yourpassword
# SMTP_FROM="Speeky AI <no-reply@speeky.ai>"
```

> **Dev email**: If no `SMTP_HOST` is set, Nodemailer creates an Ethereal test account automatically and logs the preview URL and reset link to the console.

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up the database

**Option A — Prisma Postgres cloud** (default `.env`):
```bash
# DATABASE_URL already set to Prisma cloud URL
npm run prisma:migrate
```

**Option B — Local Docker**:
```bash
docker compose up -d          # starts postgres container
# Set DATABASE_URL=postgresql://speeky:pass1234@localhost:5432/speeky_db
npm run prisma:migrate
```

### 3. Generate Prisma client

```bash
npm run prisma:generate
```

### 4. Start dev server

```bash
npm run dev
# → Speeky-AI backend listening on port 8000
```

Health check: `GET http://localhost:8000/health`

---

## API Reference

All routes are prefixed `/api/auth`.

### Public

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/signup` | `{ email, password, name? }` | Register. Sets access + refresh cookies. Returns `{ user }`. |
| `POST` | `/login` | `{ email, password }` | Login. Sets access + refresh cookies. Returns `{ user }`. |
| `POST` | `/refresh` | — | Rotate refresh token (reads cookie). Returns `{ user }`. |
| `POST` | `/logout` | — | Revokes refresh token, clears cookies. Returns `204`. |
| `POST` | `/forgot-password` | `{ email }` | Sends reset email. Always returns `200` (no user enumeration). |
| `POST` | `/reset-password` | `{ token, password }` | Resets password, revokes all refresh tokens. Returns `{ message }`. |

### Protected (requires valid `access_token` cookie)

| Method | Path | Description |
|---|---|---|
| `GET` | `/me` | Returns current user `{ id, email, name, createdAt }`. |

---

## Authentication Flow

### Session (JWT in HTTP-only cookies)

```
Client                        Server
  │── POST /signup ──────────▶│ hash password, create user
  │◀── Set-Cookie: access_token, refresh_token ──│
  │
  │── GET /me (cookie auto-sent) ──▶│ requireAuth middleware verifies access_token
  │◀── { user } ────────────────────│
  │
  │── POST /refresh ─────────▶│ verify refresh_token, rotate (revoke old, issue new)
  │◀── Set-Cookie (new tokens) ──────│
  │
  │── POST /logout ──────────▶│ revoke refresh_token, clear cookies
  │◀── 204 ──────────────────────────│
```

### Token details

| Token | Storage | TTL | Purpose |
|---|---|---|---|
| `access_token` | HTTP-only cookie, `path=/` | 30 min (configurable) | Authenticate API requests |
| `refresh_token` | HTTP-only cookie, `path=/api/auth` | 7 days (configurable) | Obtain new access tokens |

- Refresh tokens are **hashed (SHA-256)** before DB storage — raw token never persisted.
- **Token rotation** on every refresh — old token immediately revoked.
- **Reuse detection** — if a revoked refresh token is presented, all tokens for that user are revoked (theft protection).

### Password Reset Flow

```
Client                          Server
  │── POST /forgot-password ──▶│ find user, create PasswordResetToken (hashed), send email
  │◀── 200 (always) ───────────│
  │
  │  (user clicks link in email → frontend parses ?token=...)
  │
  │── POST /reset-password ───▶│ verify JWT + tokenHash lookup + check usedAt/expiry
  │                             │ → update password, mark token used, revoke all refresh tokens
  │◀── 200 { message } ────────│
```

---

## Data Models

### `User`
| Field | Type | Notes |
|---|---|---|
| `id` | `String` (cuid) | Primary key |
| `email` | `String` | Unique |
| `password` | `String` | bcrypt hash |
| `name` | `String?` | Optional |
| `createdAt` | `DateTime` | |
| `updatedAt` | `DateTime` | |

### `RefreshToken`
| Field | Type | Notes |
|---|---|---|
| `id` | `String` (cuid) | |
| `tokenHash` | `String` | SHA-256 of raw token, unique |
| `userId` | `String` | FK → User (cascade delete) |
| `revoked` | `Boolean` | Default false |
| `expiresAt` | `DateTime` | |
| `createdAt` | `DateTime` | |

### `PasswordResetToken`
| Field | Type | Notes |
|---|---|---|
| `id` | `String` (cuid) | |
| `tokenHash` | `String` | SHA-256 of raw JWT, unique |
| `userId` | `String` | FK → User (cascade delete) |
| `expiresAt` | `DateTime` | |
| `usedAt` | `DateTime?` | Set on use — enforces one-time use |
| `createdAt` | `DateTime` | |

---

## Scripts

```bash
npm run dev              # Start with node --watch (auto-restart)
npm run start            # Production start
npm run prisma:generate  # Regenerate Prisma client after schema changes
npm run prisma:migrate   # Run migrations (dev)
npm run prisma:studio    # Open Prisma Studio GUI
npm run lint:fix         # ESLint auto-fix
npm run format           # Prettier format
```

---

## Error Handling

All async controllers in Express 5 automatically propagate thrown errors to the global error handler (`middlewares/errorHandler.js`).

`AppError(message, statusCode)` — operational errors (user-facing messages shown).
Unexpected errors → `"Something went wrong!"` (stack hidden from client, logged to console).

Response shape:
```json
{ "status": "fail" | "error", "message": "..." }
```

---

## Security Notes

- All JWT secrets must be at least 256-bit random hex (see env comment for generation command).
- `access_token` cookie has `path=/` — sent on every request.
- `refresh_token` cookie has `path=/api/auth` — only sent to auth routes.
- Both cookies are `httpOnly`, `secure` (in production), `sameSite: none` (prod) / `lax` (dev).
- Login uses constant-time bcrypt comparison even when user doesn't exist (prevents timing attacks).
- Forgot-password always returns 200 regardless of whether email exists (prevents user enumeration).
- Password reset tokens are hashed in DB (never stored raw).
- On password reset, all existing refresh tokens are revoked (forces re-login on all devices).
