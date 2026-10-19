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
    connectionTimeout: 7000,
    greetingTimeout: 7000,
    socketTimeout: 10000,
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

  const mailOptions = {
    from: `"Spatio LGS Website" <${process.env.SMTP_USER}>`,
    to: process.env.CONTACT_RECEIVER_EMAIL,
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

  try {
    const transporter = createMailTransporter();
    return await transporter.sendMail(mailOptions);
  } catch (initialError) {
    console.warn("[Contact] Initial email delivery attempt failed, retrying...", initialError);
    // Brief 1.5s delay before a fresh retry
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const retryTransporter = createMailTransporter();
    return await retryTransporter.sendMail(mailOptions);
  }
}
