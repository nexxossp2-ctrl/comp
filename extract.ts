import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = "claude-haiku-4-5-20251001";

const PROMPT = `Você recebe um documento financeiro brasileiro. Ele pode ser:
- um COMPROVANTE de pagamento já REALIZADO (PIX enviado, TED concluída, comprovante de transferência, recibo de pagamento), ou
- um BOLETO / cobrança / fatura AINDA NÃO PAGA (documento para pagar, uma solicitação de pagamento), ou
- outro documento qualquer (não financeiro, foto, print, etc.).

Classifique e extraia:
- tipo: "pago" SOMENTE se for comprovante de um pagamento JÁ EFETUADO. "boleto" se for boleto a pagar, cobrança ou fatura em aberto (pagamento solicitado, ainda não concluído). "outro" se não for nenhum documento financeiro desses dois tipos.
- valor: o valor da transação ou do boleto (número, ponto decimal).
- beneficiario: o nome de quem RECEBE o pagamento (favorecido/beneficiário/destinatário/cedente).
- data_pagamento: se tipo="pago", a data em que o pagamento foi feito, no formato AAAA-MM-DD. Senão, null.
- hora_pagamento: se tipo="pago", o horário do pagamento, no formato HH:MM:SS (24h). Se não houver segundos no comprovante, use HH:MM:00. Se só tiver hora sem minutos, use HH:00:00. Senão, null.
- data_vencimento: se tipo="boleto", a data de vencimento, no formato AAAA-MM-DD. Senão, null.

Sinais de pagamento REALIZADO: "comprovante", "transferência realizada", "pagamento efetuado", "PIX enviado", data/hora da transação, ID/autenticação da transação.
Sinais de boleto A PAGAR: linha digitável, código de barras, "vencimento", "pagável em qualquer banco", "beneficiário/cedente" sem confirmação de pagamento.

Regras:
- Devolva somente JSON, sem texto antes ou depois, sem markdown.
- Formato: {"tipo": "pago", "valor": 123.45, "beneficiario": "Nome", "data_pagamento": "2026-08-22", "hora_pagamento": "15:30:42", "data_vencimento": null}
- Se não achar um campo, use null. Na dúvida entre pago e boleto, use "boleto". Na dúvida se é um documento financeiro, use "outro".`;

export interface Extracao {
  /** true somente quando tipo === "pago" (mantido por compatibilidade com o restante do código). */
  pago: boolean;
  tipo: "pago" | "boleto" | "outro";
  valor: number | null;
  beneficiario: string | null;
  data_pagamento: string | null;
  hora_pagamento: string | null;
  data_vencimento: string | null;
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
  tipo: "pago" | "boleto" | "outro";
  valor: number | null;
  beneficiario: string | null;
  data_pagamento: string | null;
  hora_pagamento: string | null;
  data_vencimento: string | null;
} {
  try {
    const limpo = raw.replace(/```json|```/g, "").trim();
    const obj = JSON.parse(limpo);
    const n = obj.valor === null || obj.valor === undefined ? null : Number(obj.valor);
    const tipo: "pago" | "boleto" | "outro" =
      obj.tipo === "pago" || obj.tipo === "boleto" || obj.tipo === "outro" ? obj.tipo : "outro";
    return {
      pago: tipo === "pago",
      tipo,
      valor: Number.isFinite(n as number) ? (n as number) : null,
      beneficiario: obj.beneficiario ? String(obj.beneficiario) : null,
      data_pagamento: obj.data_pagamento ? String(obj.data_pagamento) : null,
      hora_pagamento: obj.hora_pagamento ? String(obj.hora_pagamento) : null,
      data_vencimento: obj.data_vencimento ? String(obj.data_vencimento) : null,
    };
  } catch {
    return {
      pago: false,
      tipo: "outro",
      valor: null,
      beneficiario: null,
      data_pagamento: null,
      hora_pagamento: null,
      data_vencimento: null,
    };
  }
}
