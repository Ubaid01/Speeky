import nodemailer from "nodemailer";

/**
 * Creates a transporter.
 * In development with no SMTP configured, uses Ethereal (logs preview URL).
 * In production, uses SMTP_HOST/PORT/USER/PASS from env.
 */
async function createTransporter() {
  if (
    process.env.NODE_ENV !== "production" &&
    !process.env.SMTP_HOST
  ) {
    // Ethereal: fake SMTP for development, emails appear at ethereal.email
    const testAccount = await nodemailer.createTestAccount();
    return nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/**
 * Sends a password-reset email.
 * @param {string} to  Recipient email address
 * @param {string} resetUrl  Full reset URL with token
 */
export async function sendPasswordResetEmail(to, resetUrl) {
  const transporter = await createTransporter();

  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM ?? '"Speeky AI" <no-reply@speeky.ai>',
    to,
    subject: "Reset your Speeky AI password",
    text: `You requested a password reset.\n\nClick the link below (valid for ${process.env.RESET_TOKEN_TTL_MINUTES ?? 15} minutes):\n\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
    html: `
      <p>You requested a password reset.</p>
      <p>Click the link below (valid for <strong>${process.env.RESET_TOKEN_TTL_MINUTES ?? 15} minutes</strong>):</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>If you did not request this, ignore this email.</p>
    `,
  });

  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[DEV] Password reset email preview: ${nodemailer.getTestMessageUrl(info)}`,
    );
    console.log(`[DEV] Reset URL: ${resetUrl}`);
  }
}
