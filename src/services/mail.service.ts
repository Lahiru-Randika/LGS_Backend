import 'dotenv/config';
import nodemailer from "nodemailer";

export function createMailTransporter() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    family: 4, // strictly force IPv4 to avoid IPv6 connection stalls
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: {
      user,
      pass,
    },
  } as any);
}

export async function sendContactEmail(data: {
  fullName: string;
  email: string;
  serviceNeed: string;
  message: string;
}) {
  const { fullName, email, serviceNeed, message } = data;

  const targetRecipient = (process.env.CONTACT_RECEIVER_EMAIL || "").trim();
  const smtpUser = (process.env.SMTP_USER || "").trim();

  if (!smtpUser || !process.env.SMTP_PASS || !targetRecipient) {
    console.error("[SMTP Diagnostics] Missing SMTP configuration in environment:", {
      hasUser: Boolean(smtpUser),
      hasPass: Boolean(process.env.SMTP_PASS),
      hasReceiver: Boolean(targetRecipient),
    });
    throw new Error("SMTP configuration is incomplete on this server.");
  }

  const mailOptions = {
    from: `"Spatio LGS Website" <${smtpUser}>`,
    to: targetRecipient,
    replyTo: email,
    subject: `Spatio LGS Contact: ${serviceNeed}`,
    text: `
New Spatio LGS Contact Request

Full Name: ${fullName}
Email: ${email}
Service Need: ${serviceNeed}

Message:
${message}
    `,
  };

  const startTime = Date.now();
  console.log(`[SMTP Diagnostics] Initiating email delivery to ${targetRecipient}...`);

  try {
    const transporter = createMailTransporter();
    const info = await transporter.sendMail(mailOptions);
    const duration = Date.now() - startTime;

    console.log("[SMTP Diagnostics] Delivery succeeded:");
    console.log("  SMTP duration (ms):", duration);
    console.log("  SMTP message ID:", info.messageId);
    console.log("  SMTP accepted:", info.accepted);
    console.log("  SMTP rejected:", info.rejected);
    console.log("  SMTP response:", info.response);

    const acceptedList = (Array.isArray(info.accepted) ? info.accepted : []).map((r) =>
      String(r).toLowerCase()
    );
    const isAccepted = acceptedList.some((r) => r.includes(targetRecipient.toLowerCase()));

    if (!isAccepted) {
      throw new Error(`SMTP server rejected intended recipient: ${targetRecipient}`);
    }

    return info;
  } catch (err: any) {
    const duration = Date.now() - startTime;
    console.error("[SMTP Diagnostics] Delivery failed:", {
      durationMs: duration,
      code: err?.code,
      command: err?.command,
      responseCode: err?.responseCode,
      response: err?.response,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
