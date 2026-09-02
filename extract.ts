import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = "claude-haiku-4-5-20251001";

const PROMPT = `Você recebe um documento financeiro brasileiro. Ele pode ser:
- um COMPROVANTE de pagamento já REALIZADO (PIX enviado, TED concluída, comprovante de transferência, recibo de pagamento, comprovante de pagamento de DARF/tributo), ou
- um BOLETO / cobrança / fatura AINDA NÃO PAGA (documento para pagar, uma solicitação de pagamento) — inclui DARF, GPS e outras guias de tributo ainda não pagas, ou
- uma NOTA FISCAL (NF-e / DANFE) ainda não paga — documento de venda/prestação de serviço, referência pra depois gerar boleto(s) de pagamento, ou
- um CT-e (Conhecimento de Transporte Eletrônico / DACTE) — documento de frete/transporte, geralmente acompanha uma ou mais notas fiscais que já vão ser cobradas juntas num único boleto consolidado, ou
- outro documento qualquer (não financeiro, foto, print, sticker, etc.).

Classifique e extraia:
- tipo: "pago" SOMENTE se for comprovante de um pagamento JÁ EFETUADO. "boleto" se for boleto a pagar, cobrança, fatura ou guia de tributo (DARF/GPS/DAS) em aberto (pagamento solicitado, ainda não concluído). "nf" se for nota fiscal eletrônica (NF-e/DANFE) ainda não paga. "cte" se for Conhecimento de Transporte Eletrônico (CT-e/DACTE). "outro" se não for nenhum documento financeiro desses quatro tipos.
- valor: o valor da transação, do boleto/guia, o valor total da nota fiscal, ou o valor do frete do CT-e (número, ponto decimal).
- beneficiario: o nome de quem RECEBE o pagamento. Num boleto normal é o favorecido/beneficiário/cedente. Numa nota fiscal ou CT-e é o EMITENTE (quem vendeu/prestou o serviço/transporte — é ele que vai receber). Numa DARF, GPS ou outra guia de tributo federal/estadual (documento de arrecadação, sem cedente nomeado) o beneficiário é sempre o nome do órgão arrecadador (ex: "Receita Federal", "INSS") — NUNCA o nome/razão social do contribuinte que está pagando, mesmo que seja o único nome próprio visível no documento.
- numero_nf: se tipo="nf", o número da nota fiscal (como texto, ex: "12345"). Senão, null.
- data_pagamento: se tipo="pago", a data em que o pagamento foi feito, no formato AAAA-MM-DD. Senão, null.
- hora_pagamento: se tipo="pago", o horário do pagamento, no formato HH:MM:SS (24h). Se não houver segundos no comprovante, use HH:MM:00. Se só tiver hora sem minutos, use HH:00:00. Senão, null.
- data_vencimento: se tipo="boleto" ou tipo="nf" (quando a nota mostrar uma data de vencimento/pagamento), a data de vencimento, no formato AAAA-MM-DD. Senão, null.

Sinais de pagamento REALIZADO: "comprovante", "transferência realizada", "pagamento efetuado", "PIX enviado", data/hora da transação, ID/autenticação da transação.
Sinais de boleto/guia A PAGAR: linha digitável, código de barras, "vencimento", "pagável em qualquer banco", "beneficiário/cedente" sem confirmação de pagamento, ou (pra DARF/GPS/DAS) brasão da Receita Federal/INSS com "Documento de Arrecadação".
Sinais de NOTA FISCAL: "NF-e", "Nota Fiscal Eletrônica", "DANFE", "Chave de Acesso" (44 dígitos), "Emitente"/"Destinatário", CFOP/NCM, "Natureza da Operação" — mesmo tendo código de barras (é o da chave de acesso, não é boleto).
Sinais de CT-e: título "Documento Auxiliar do Conhecimento de Transporte Eletrônico" ou "DACTE" ou "CT-e" no cabeçalho do documento.

Regras:
- Devolva somente JSON, sem texto antes ou depois, sem markdown.
- Formato: {"tipo": "pago", "valor": 123.45, "beneficiario": "Nome", "numero_nf": null, "data_pagamento": "2026-08-22", "hora_pagamento": "15:30:42", "data_vencimento": null}
- Se não achar um campo, use null. Na dúvida entre pago e boleto, use "boleto". Na dúvida entre boleto e nf, use "nf" se tiver "DANFE"/"NF-e"/chave de acesso. Se tiver o título do CT-e/DACTE, sempre use "cte" (nunca "nf"). Na dúvida se é um documento financeiro, use "outro".`;

export interface Extracao {
  /** true somente quando tipo === "pago" (mantido por compatibilidade com o restante do código). */
  pago: boolean;
  tipo: "pago" | "boleto" | "nf" | "cte" | "outro";
  valor: number | null;
  beneficiario: string | null;
  numero_nf: string | null;
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
  tipo: "pago" | "boleto" | "nf" | "cte" | "outro";
  valor: number | null;
  beneficiario: string | null;
  numero_nf: string | null;
  data_pagamento: string | null;
  hora_pagamento: string | null;
  data_vencimento: string | null;
} {
  try {
    const limpo = raw.replace(/```json|```/g, "").trim();
    const obj = JSON.parse(limpo);
    const n = obj.valor === null || obj.valor === undefined ? null : Number(obj.valor);
    const tipo: "pago" | "boleto" | "nf" | "cte" | "outro" =
      obj.tipo === "pago" || obj.tipo === "boleto" || obj.tipo === "nf" || obj.tipo === "cte" || obj.tipo === "outro"
        ? obj.tipo
        : "outro";
    return {
      pago: tipo === "pago",
      tipo,
      valor: Number.isFinite(n as number) ? (n as number) : null,
      beneficiario: obj.beneficiario ? String(obj.beneficiario) : null,
      numero_nf: obj.numero_nf ? String(obj.numero_nf) : null,
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
      numero_nf: null,
      data_pagamento: null,
      hora_pagamento: null,
      data_vencimento: null,
    };
  }
}
