import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = "claude-haiku-4-5-20251001";

const PROMPT = `Você recebe um documento financeiro brasileiro. Ele pode ser:
- um COMPROVANTE de pagamento já REALIZADO (PIX enviado, TED concluída, comprovante de transferência, recibo de pagamento), ou
- um BOLETO / cobrança / fatura AINDA NÃO PAGA (documento para pagar), ou
- outro documento qualquer.

Classifique e extraia:
- pago: true SOMENTE se for comprovante de um pagamento JÁ EFETUADO. Para boleto a pagar, cobrança, fatura em aberto ou qualquer coisa não concluída, use false.
- valor: o valor da transação (número, ponto decimal).
- beneficiario: o nome de quem RECEBEU o pagamento (favorecido/beneficiário/destinatário).
- data_pagamento: a data em que o pagamento foi feito, no formato AAAA-MM-DD.
- hora_pagamento: o horário do pagamento, no formato HH:MM:SS (24h). Se não houver segundos no comprovante, use HH:MM:00. Se só tiver hora sem minutos, use HH:00:00.

Sinais de pagamento REALIZADO: "comprovante", "transferência realizada", "pagamento efetuado", "PIX enviado", data/hora da transação, ID/autenticação da transação.
Sinais de boleto A PAGAR: linha digitável, código de barras, "vencimento", "pagável em qualquer banco", "beneficiário/cedente" sem confirmação de pagamento.

Regras:
- Devolva somente JSON, sem texto antes ou depois, sem markdown.
- Formato: {"pago": true, "valor": 123.45, "beneficiario": "Nome", "data_pagamento": "2026-08-22", "hora_pagamento": "15:30:42"}
- Se não achar um campo, use null. Na dúvida sobre o pagamento, use pago:false.`;

export interface Extracao {
  pago: boolean;
  valor: number | null;
  beneficiario: string | null;
  data_pagamento: string | null;
  hora_pagamento: string | null;
  raw: string;
}

export async function baixarBase64(url: string): Promise<{ data: string; mediaType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar arquivo (${res.status})`);
  const mediaType = res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf.toString("base64"), mediaType };
}

/** Extrai a partir de uma URL (caminho do WhatsApp). */
export async function extrair(fileUrl: string, mimeType: string): Promise<Extracao> {
  const { data, mediaType } = await baixarBase64(fileUrl);
  return extrairBase64(data, mimeType || mediaType);
}

/** Extrai a partir do arquivo já em base64 (caminho do upload). */
export async function extrairBase64(data: string, mimeType: string): Promise<Extracao> {
  const tipo = (mimeType || "").toLowerCase();

  const bloco =
    tipo.includes("pdf")
      ? {
          type: "document" as const,
          source: { type: "base64" as const, media_type: "application/pdf" as const, data },
        }
      : {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(tipo)
              ? tipo
              : "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data,
          },
        };

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 200,
    messages: [{ role: "user", content: [bloco, { type: "text", text: PROMPT }] }],
  });

  const raw = resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();

  return { ...parse(raw), raw };
}

function parse(raw: string): {
  pago: boolean;
  valor: number | null;
  beneficiario: string | null;
  data_pagamento: string | null;
  hora_pagamento: string | null;
} {
  try {
    const limpo = raw.replace(/```json|```/g, "").trim();
    const obj = JSON.parse(limpo);
    const n = obj.valor === null || obj.valor === undefined ? null : Number(obj.valor);
    return {
      pago: obj.pago === true,
      valor: Number.isFinite(n as number) ? (n as number) : null,
      beneficiario: obj.beneficiario ? String(obj.beneficiario) : null,
      data_pagamento: obj.data_pagamento ? String(obj.data_pagamento) : null,
      hora_pagamento: obj.hora_pagamento ? String(obj.hora_pagamento) : null,
    };
  } catch {
    return { pago: false, valor: null, beneficiario: null, data_pagamento: null, hora_pagamento: null };
  }
}
