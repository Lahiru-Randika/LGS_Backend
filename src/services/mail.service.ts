import 'dotenv/config';
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

let cachedTransporter: Transporter | null = null;
let cachedCredentials = '';

export function getTransporter(): Transporter {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  const credsKey = `${host}:${port}:${user}:${pass}`;

  if (cachedTransporter && cachedCredentials === credsKey) {
    return cachedTransporter;
  }

  const isSecure = port === 465;

  const transportOptions: any = {
    host,
    port,
    secure: isSecure,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 8000,
    family: 4, // strictly force IPv4 to avoid IPv6 connection stalls
    auth: {
      user,
      pass,
    },
  };

  cachedTransporter = nodemailer.createTransport(transportOptions);
  cachedCredentials = credsKey;
  return cachedTransporter;
}

export async function sendContactEmail(data: {
  fullName: string;
  email: string;
  serviceNeed: string;
  message: string;
}) {
  const { fullName, email, serviceNeed, message } = data;
  const transporter = getTransporter();

  await transporter.sendMail({
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
  });
}
