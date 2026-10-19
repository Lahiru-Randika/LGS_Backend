import { Router } from "express";
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

    await sendContactEmail({
      fullName,
      email,
      serviceNeed,
      message,
    });

    res.status(200).json({
      success: true,
      message: "Your message has been sent successfully.",
    });
  } catch (error) {
    console.error("Contact email delivery failed:", error);

    res.status(500).json({
      success: false,
      message: "Unable to send your message right now.",
    });
  }
});

export default router;
