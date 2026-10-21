import crypto from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { pool } from "../config/db";
import { sendContactEmail } from "../services/mail.service";

const router = Router();

// Anti-spam rate limiter for public contact form: 30 requests per 15 minutes per IP
const contactRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many contact submissions from this network. Please wait a few minutes.",
  },
});

router.post("/", contactRateLimit, async (req, res) => {
  const { fullName, email, serviceNeed, message } = req.body || {};

  // Server-side validation
  if (
    typeof fullName !== "string" ||
    typeof email !== "string" ||
    typeof serviceNeed !== "string" ||
    typeof message !== "string" ||
    !fullName.trim() ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
    !serviceNeed.trim() ||
    !message.trim() ||
    fullName.length > 150 ||
    email.length > 254 ||
    serviceNeed.length > 200 ||
    message.length > 5000
  ) {
    res.status(400).json({
      success: false,
      message: "Please provide valid contact details.",
    });
    return;
  }

  const cleanFullName = fullName.trim();
  const cleanEmail = email.trim().toLowerCase();
  const cleanServiceNeed = serviceNeed.trim();
  const cleanMessage = message.trim();
  const publicId = crypto.randomUUID();

  // 1. Persist inquiry in database first so citizen inquiries are never lost
  try {
    await pool.execute(
      `INSERT INTO contact_messages (public_id, name, email, subject, message, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', UTC_TIMESTAMP())`,
      [publicId, cleanFullName, cleanEmail, cleanServiceNeed, cleanMessage]
    );
  } catch (dbErr) {
    console.warn("[Contact] Failed to record inquiry to database:", dbErr);
  }

  // 2. Synchronously await SMTP delivery — only return HTTP 200 after provider acceptance
  try {
    const result = await sendContactEmail({
      fullName: cleanFullName,
      email: cleanEmail,
      serviceNeed: cleanServiceNeed,
      message: cleanMessage,
    });

    // Update database status to SENT
    await pool
      .execute(
        `UPDATE contact_messages SET status = 'SENT' WHERE public_id = ?`,
        [publicId]
      )
      .catch(() => {});

    console.log(`[Contact] Inquiry ${publicId} confirmed sent (Message ID: ${result?.messageId})`);

    res.status(200).json({
      success: true,
      message: "Your message has been sent successfully.",
    });
  } catch (deliveryError: any) {
    // Update database status to FAILED
    await pool
      .execute(
        `UPDATE contact_messages SET status = 'FAILED' WHERE public_id = ?`,
        [publicId]
      )
      .catch(() => {});

    console.error(`[Contact] Delivery failed for inquiry ${publicId}:`, {
      code: deliveryError?.code,
      message: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
    });

    // Return explicit error status (502 Bad Gateway) — NEVER return 200 on failure
    res.status(502).json({
      success: false,
      message: "Unable to deliver your message right now. Please try again later.",
    });
  }
});

export default router;
