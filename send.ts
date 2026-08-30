import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_PORT === "465",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

export async function enviarEmail(assunto: string, texto: string): Promise<void> {
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: process.env.REPORT_EMAIL_TO,
    subject: assunto,
    text: texto,
  });
}

/** Envia email com anexos pra um destinatário específico. */
export async function enviarEmailComAnexos(
  para: string,
  assunto: string,
  texto: string,
  anexos: { filename: string; content: Buffer }[],
): Promise<void> {
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: para,
    subject: assunto,
    text: texto,
    attachments: anexos,
  });
}

/** Envia o relatório por WhatsApp via Z-API (send-text). Destino = grupo ou número. */
export async function enviarWhatsapp(mensagem: string): Promise<void> {
  const url = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}/send-text`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Client-Token": process.env.ZAPI_CLIENT_TOKEN || "",
    },
    body: JSON.stringify({
      phone: process.env.REPORT_WHATSAPP_PHONE,
      message: mensagem,
    }),
  });

  if (!res.ok) {
    throw new Error(`Z-API send-text falhou (${res.status}): ${await res.text()}`);
  }
}
