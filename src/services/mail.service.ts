import 'dotenv/config';
import nodemailer from "nodemailer";

function getTransporter() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host.includes("gmail")) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: {
        user,
        pass,
      },
    });
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass,
    },
  });
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
