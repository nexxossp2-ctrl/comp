import nodemailer from "nodemailer";

// .trim() em tudo: variável de ambiente colada com espaço/quebra de linha a
// mais no final é uma causa clássica de "queryA EBADNAME" na hora de mandar email.
const env = (nome: string): string => (process.env[nome] || "").trim();

const transporter = nodemailer.createTransport({
  host: env("SMTP_HOST"),
  port: Number(env("SMTP_PORT")) || 587,
  secure: env("SMTP_PORT") === "465",
  auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") },
});

export async function enviarEmail(assunto: string, texto: string): Promise<void> {
  await transporter.sendMail({
    from: env("SMTP_FROM") || env("SMTP_USER"),
    to: env("REPORT_EMAIL_TO"),
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
    from: env("SMTP_FROM") || env("SMTP_USER"),
    to: para.trim(),
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
