import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export interface NfVenda {
  id: number;
  message_id: string;
  numero_nf: string;
  cnpj: string | null;
  cliente: string | null;
  valor: number | null;
  data: string;
  arquivo_url: string | null;
  file_name: string | null;
  status: "pendente" | "dividida";
  created_at: string;
}

export interface BoletoVenda {
  id: number;
  nf_id: number;
  seu_numero: string;
  banco: string | null;
  valor: number;
  status: "aberto" | "pago" | "nao_conciliado";
  data_pagamento: string | null;
  created_at: string;
}

export interface ConciliacaoPendente {
  id: number;
  pagador: string | null;
  valor: number | null;
  seu_numero: string | null;
  status: "pendente" | "resolvido";
  boleto_id: number | null;
  created_at: string;
}

/** Sobe o XML da NF de venda pro mesmo Storage privado dos comprovantes, em pasta separada. */
export async function subirArquivoXmlVenda(conteudoXml: string, nomeBase: string): Promise<string | null> {
  try {
    const buffer = Buffer.from(conteudoXml, "utf-8");
    const path = `vendas/${new Date().toISOString().slice(0, 10)}/${nomeBase}.xml`;
    const { error } = await supabase.storage.from("comprovantes").upload(path, buffer, {
      contentType: "text/xml",
      upsert: true,
    });
    if (error) {
      console.error("[storage] upload xml venda falhou:", error.message);
      return null;
    }
    return path;
  } catch (e) {
    console.error("[storage] erro upload xml venda:", e);
    return null;
  }
}

/**
 * Salva uma NF de venda. Dedupe por message_id (UNIQUE no banco), igual comprovantes.
 * Retorna a linha inserida, ou null se já existia (duplicado).
 */
export async function salvarNfVenda(nf: {
  message_id: string;
  numero_nf: string;
  cnpj: string | null;
  cliente: string | null;
  valor: number | null;
  data: string;
  arquivo_url: string | null;
  file_name: string | null;
}): Promise<NfVenda | null> {
  const { data: row, error } = await supabase
    .from("nfs_venda")
    .insert(nf)
    .select()
    .single();

  if (!error) return row as NfVenda;
  if (error.code === "23505") return null; // já processada
  throw error;
}

/** Lista NFs de venda, mais recentes primeiro. Filtro opcional por status. */
export async function listarNfsVenda(status?: "pendente" | "dividida"): Promise<NfVenda[]> {
  let q = supabase.from("nfs_venda").select("*").order("data", { ascending: false }).order("created_at", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as NfVenda[];
}

export async function buscarNfVendaPorId(id: number): Promise<NfVenda | null> {
  const { data, error } = await supabase.from("nfs_venda").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as NfVenda) ?? null;
}

/**
 * Grava a divisão de uma NF em N boletos, marca a NF como "dividida" e cria
 * a linha do relatório de solicitação (numeração sequencial = id da linha).
 * Tudo isso precisa acontecer junto — se algo falhar no meio, quem chama
 * decide se tenta de novo (não há transação multi-tabela no supabase-js;
 * a ordem abaixo minimiza inconsistência: boletos primeiro, status por último).
 */
export async function dividirNfEmBoletos(
  nfId: number,
  numeroNf: string,
  itens: { banco: string | null; valor: number }[],
): Promise<{ boletos: BoletoVenda[]; relatorioId: number }> {
  const seuNumeroBase = `NF${String(numeroNf).padStart(3, "0")}`;

  const paraInserir = itens.map((it) => ({
    nf_id: nfId,
    seu_numero: seuNumeroBase,
    banco: it.banco,
    valor: it.valor,
    status: "aberto" as const,
  }));

  const { data: boletos, error: errBoletos } = await supabase
    .from("boletos_venda")
    .insert(paraInserir)
    .select();
  if (errBoletos) throw errBoletos;

  const { error: errStatus } = await supabase
    .from("nfs_venda")
    .update({ status: "dividida" })
    .eq("id", nfId);
  if (errStatus) throw errStatus;

  const { data: relatorio, error: errRel } = await supabase
    .from("relatorios_solicitacao")
    .insert({ nf_id: nfId })
    .select()
    .single();
  if (errRel) throw errRel;

  return { boletos: (boletos ?? []) as BoletoVenda[], relatorioId: relatorio.id };
}

export async function buscarRelatorioPorId(id: number): Promise<{ id: number; nf_id: number } | null> {
  const { data, error } = await supabase.from("relatorios_solicitacao").select("id, nf_id").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** Lista boletos de venda, mais recentes primeiro. Filtro opcional por status. */
export async function listarBoletosVenda(status?: "aberto" | "pago" | "nao_conciliado"): Promise<
  (BoletoVenda & { nf: Pick<NfVenda, "numero_nf" | "cliente" | "cnpj"> | null })[]
> {
  let q = supabase
    .from("boletos_venda")
    .select("*, nf:nfs_venda(numero_nf, cliente, cnpj)")
    .order("created_at", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as any;
}

/** Boletos de uma NF específica — usado pra montar o relatório de solicitação. */
export async function listarBoletosPorNf(nfId: number): Promise<BoletoVenda[]> {
  const { data, error } = await supabase.from("boletos_venda").select("*").eq("nf_id", nfId);
  if (error) throw error;
  return (data ?? []) as BoletoVenda[];
}

/** Boletos em aberto — usado pela conciliação do CSV. */
export async function boletosEmAberto(): Promise<BoletoVenda[]> {
  const { data, error } = await supabase.from("boletos_venda").select("*").eq("status", "aberto");
  if (error) throw error;
  return (data ?? []) as BoletoVenda[];
}

export async function marcarBoletoPago(id: number, dataPagamento: string): Promise<void> {
  const { error } = await supabase
    .from("boletos_venda")
    .update({ status: "pago", data_pagamento: dataPagamento })
    .eq("id", id);
  if (error) throw error;
}

/** Grava as linhas do CSV que não bateram com nenhum boleto em aberto. */
export async function salvarConciliacoesPendentes(
  linhas: { pagador: string | null; valor: number | null; seu_numero: string | null }[],
): Promise<void> {
  if (linhas.length === 0) return;
  const { error } = await supabase.from("conciliacoes_pendentes").insert(
    linhas.map((l) => ({ ...l, status: "pendente" as const })),
  );
  if (error) throw error;
}

export async function listarConciliacoesPendentes(): Promise<ConciliacaoPendente[]> {
  const { data, error } = await supabase
    .from("conciliacoes_pendentes")
    .select("*")
    .eq("status", "pendente")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ConciliacaoPendente[];
}

/** Resolve manualmente uma conciliação pendente, vinculando a um boleto e dando baixa nele. */
export async function resolverConciliacaoPendente(
  conciliacaoId: number,
  boletoId: number,
  dataPagamento: string,
): Promise<void> {
  await marcarBoletoPago(boletoId, dataPagamento);
  const { error } = await supabase
    .from("conciliacoes_pendentes")
    .update({ status: "resolvido", boleto_id: boletoId })
    .eq("id", conciliacaoId);
  if (error) throw error;
}
