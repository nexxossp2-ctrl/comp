// Envio de email via Resend (API HTTPS), não SMTP direto.
// O Railway (como a maioria das hospedagens em nuvem) bloqueia conexões SMTP
// de saída pra evitar spam — isso causava ETIMEDOUT ao tentar falar direto
// com smtp.gmail.com. A API do Resend funciona por HTTPS normal (porta 443),
// que nunca é bloqueada.
const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
// "onboarding@resend.dev" funciona sem configurar domínio, mas só entrega pro
// email da própria conta Resend (modo teste). Pra mandar pra qualquer
// destinatário, verifique um domínio no Resend e configure RESEND_FROM com
// um endereço desse domínio (ex: relatorios@seudominio.com.br).
const RESEND_FROM = (process.env.RESEND_FROM || "onboarding@resend.dev").trim();

async function enviarViaResend(params: {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: Buffer }[];
}): Promise<void> {
  const body: Record<string, unknown> = {
    from: RESEND_FROM,
    to: [params.to],
    subject: params.subject,
    text: params.text,
  };
  if (params.attachments?.length) {
    body.attachments = params.attachments.map((a) => ({
      filename: a.filename,
      content: a.content.toString("base64"),
    }));
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Resend falhou (${res.status}): ${await res.text()}`);
  }
}

export async function enviarEmail(assunto: string, texto: string): Promise<void> {
  const destino = (process.env.REPORT_EMAIL_TO || "").trim();
  if (!destino) {
    console.warn("[email] REPORT_EMAIL_TO não configurado — email não enviado.");
    return;
  }
  await enviarViaResend({ to: destino, subject: assunto, text: texto });
}

/** Envia email com anexos pra um destinatário específico. */
export async function enviarEmailComAnexos(
  para: string,
  assunto: string,
  texto: string,
  anexos: { filename: string; content: Buffer }[],
): Promise<void> {
  await enviarViaResend({ to: para.trim(), subject: assunto, text: texto, attachments: anexos });
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
