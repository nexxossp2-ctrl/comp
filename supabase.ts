import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export interface Comprovante {
  message_id: string;
  valor: number | null;
  data: string; // YYYY-MM-DD
  /** "pago" = comprovante de pagamento já feito. "solicitado" = boleto/cobrança/NF em aberto. */
  status: "pago" | "solicitado";
  vencimento?: string | null; // YYYY-MM-DD, só para status="solicitado"
  beneficiario?: string | null;
  remetente?: string | null;
  fingerprint?: string | null;
  arquivo_url?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  raw_valor?: string | null;
  /** Tipo real identificado ("pago" | "boleto" | "nf") — mais granular que "status", usado só pra exibir a etiqueta no dashboard. */
  doc_tipo?: string | null;
  /** Número da nota fiscal, só quando doc_tipo="nf". */
  numero_nf?: string | null;
}

/** Sobe o arquivo do comprovante pro Storage privado. Retorna o caminho (path). */
export async function subirArquivo(base64: string, mime: string, nomeBase: string): Promise<string | null> {
  try {
    const buffer = Buffer.from(base64, "base64");
    const ext = mime.includes("pdf") ? "pdf" : mime.includes("png") ? "png" : "jpg";
    const path = `${new Date().toISOString().slice(0, 10)}/${nomeBase}.${ext}`;
    const { error } = await supabase.storage.from("comprovantes").upload(path, buffer, {
      contentType: mime,
      upsert: true,
    });
    if (error) {
      console.error("[storage] upload falhou:", error.message);
      return null;
    }
    return path;
  } catch (e) {
    console.error("[storage] erro:", e);
    return null;
  }
}

/** Gera um link temporário (assinado) pra visualizar o arquivo. Válido 1h. */
export async function linkAssinado(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from("comprovantes").createSignedUrl(path, 3600);
  if (error) return null;
  return data?.signedUrl ?? null;
}

/** Busca comprovantes por lista de identificadores (message_id). Retorna path do arquivo + dados. */
export async function comprovantesPorIds(
  ids: string[],
): Promise<
  { message_id: string; arquivo_url: string | null; data: string; valor: number | null; beneficiario: string | null; remetente: string | null }[]
> {
  const { data: rows, error } = await supabase
    .from("comprovantes")
    .select("message_id, arquivo_url, data, valor, beneficiario, remetente")
    .in("message_id", ids);
  if (error) throw error;
  return rows ?? [];
}

/** Baixa os bytes de um arquivo do Storage. */
export async function baixarArquivo(path: string): Promise<Buffer | null> {
  const { data, error } = await supabase.storage.from("comprovantes").download(path);
  if (error || !data) return null;
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Insere o comprovante. Dedupe por message_id (UNIQUE no banco).
 * Retorna true se inseriu, false se já existia (duplicado ignorado).
 */
export async function salvarComprovante(c: Comprovante): Promise<boolean> {
  const { error } = await supabase.from("comprovantes").insert(c);

  if (!error) return true;

  // 23505 = violação de unique = já processado. Não é erro real.
  if (error.code === "23505") return false;

  throw error;
}

/**
 * Apaga um comprovante/solicitação pelo message_id, e o arquivo associado no Storage
 * (best-effort — se a remoção do arquivo falhar, o registro já foi apagado mesmo assim).
 * Usado pela exclusão manual no dashboard, protegida por senha no endpoint.
 */
export async function excluirComprovante(messageId: string): Promise<{ ok: boolean }> {
  const { data: row, error: errBusca } = await supabase
    .from("comprovantes")
    .select("arquivo_url")
    .eq("message_id", messageId)
    .maybeSingle();
  if (errBusca) throw errBusca;
  if (!row) return { ok: false };

  const { error } = await supabase.from("comprovantes").delete().eq("message_id", messageId);
  if (error) throw error;

  if (row.arquivo_url) {
    try {
      await supabase.storage.from("comprovantes").remove([row.arquivo_url]);
    } catch (e) {
      console.error("[storage] falha ao remover arquivo:", e);
    }
  }
  return { ok: true };
}

export interface ComprovanteRow {
  message_id: string;
  valor: number | null;
  data: string;
  status: "pago" | "solicitado";
  vencimento: string | null;
  beneficiario: string | null;
  remetente: string | null;
  arquivo_url: string | null;
  doc_tipo: string | null;
  numero_nf: string | null;
}

const COLUNAS_LISTAGEM =
  "message_id, valor, data, status, vencimento, beneficiario, remetente, arquivo_url, doc_tipo, numero_nf";

/** Comprovantes PAGOS de um dia (YYYY-MM-DD), na ordem em que chegaram. Usado pelo relatório diário. */
export async function comprovantesDoDia(data: string): Promise<ComprovanteRow[]> {
  const { data: rows, error } = await supabase
    .from("comprovantes")
    .select(COLUNAS_LISTAGEM)
    .eq("data", data)
    .eq("status", "pago")
    .order("created_at", { ascending: true });

  if (error) throw error;
  return rows ?? [];
}

/** Lista com filtros por intervalo de data, beneficiário e status (para o dashboard). */
export async function listarComprovantes(opts: {
  inicio?: string;
  fim?: string;
  beneficiario?: string;
  /** "pago" | "solicitado" filtra por tipo. Omitido = todos os status. */
  status?: string;
}): Promise<ComprovanteRow[]> {
  let q = supabase
    .from("comprovantes")
    .select(COLUNAS_LISTAGEM)
    .order("data", { ascending: false })
    .order("created_at", { ascending: false });

  if (opts.inicio) q = q.gte("data", opts.inicio);
  if (opts.fim) q = q.lte("data", opts.fim);
  if (opts.beneficiario) q = q.ilike("beneficiario", `%${opts.beneficiario}%`);
  if (opts.status) q = q.eq("status", opts.status);

  const { data: rows, error } = await q;
  if (error) throw error;
  return rows ?? [];
}
