import crypto from "node:crypto";
import { Router } from "express";
import { pool } from "../config/db";
import { sendContactEmail } from "../services/mail.service";

const router = Router();

router.post("/", async (req, res) => {
  try {
    const { fullName, email, serviceNeed, message } = req.body;

    if (
      typeof fullName !== "string" ||
      typeof email !== "string" ||
      typeof serviceNeed !== "string" ||
      typeof message !== "string" ||
      !fullName.trim() ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !serviceNeed.trim() ||
      !message.trim() ||
      fullName.length > 150 ||
      email.length > 254 ||
      serviceNeed.length > 200 ||
      message.length > 5000
    ) {
      res.status(400).json({
        message: "Please provide valid contact details.",
      });
      return;
    }

    const publicId = crypto.randomUUID();

    // 1. Immediately record in database so user message is never lost
    try {
      await pool.execute(
        `INSERT INTO contact_messages (public_id, name, email, subject, message, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'NEW', UTC_TIMESTAMP())`,
        [publicId, fullName.trim(), email.trim().toLowerCase(), serviceNeed.trim(), message.trim()]
      );
    } catch (dbErr) {
      console.warn("[Contact] Failed to persist inquiry to database:", dbErr);
    }

    // 2. Respond immediately to the frontend so user is not stuck waiting
    res.status(200).json({
      success: true,
      message: "Your message has been sent successfully.",
    });

    // 3. Dispatch the email in the background asynchronously
    sendContactEmail({
      fullName: fullName.trim(),
      email: email.trim().toLowerCase(),
      serviceNeed: serviceNeed.trim(),
      message: message.trim(),
    })
      .then(() => {
        console.log(`[Contact] Email delivered successfully for inquiry ${publicId}`);
        pool
          .execute(
            `UPDATE contact_messages SET status = 'SENT' WHERE public_id = ?`,
            [publicId]
          )
          .catch(() => {});
      })
      .catch((mailErr) => {
        console.error(`[Contact] Background email delivery failed for inquiry ${publicId}:`, mailErr);
        pool
          .execute(
            `UPDATE contact_messages SET status = 'FAILED' WHERE public_id = ?`,
            [publicId]
          )
          .catch(() => {});
      });
  } catch (error) {
    console.error("Contact request error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to process your request right now.",
    });
  }
});

export default router;
