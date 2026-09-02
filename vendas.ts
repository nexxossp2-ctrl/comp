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
  relatorio_id: number | null;
  seu_numero: string;
  banco: string | null;
  valor: number;
  status: "aberto" | "pago" | "nao_conciliado" | "cancelado";
  data_pagamento: string | null;
  created_at: string;
}

export interface NfVendaComSaldo extends NfVenda {
  /** valor total da NF (mesmo que "valor", mas nunca null aqui — 0 se vier null) */
  emitido: number;
  /** soma dos boletos já pagos dessa NF */
  liquidado: number;
  /** emitido menos o que já está alocado em boleto (aberto ou pago — cancelado não conta) */
  disponivel: number;
  /** "nao_utilizada": nunca teve boleto. "parcial": tem boleto(s) mas ainda sobra saldo. "utilizada": saldo zerado. */
  situacao: "nao_utilizada" | "parcial" | "utilizada";
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

/**
 * Soma, por NF, quanto já foi alocado em boleto (aberto+pago, cancelado não
 * conta) e quanto já foi pago — é isso que decide se ainda cabe dividir mais
 * um pedaço da nota ou não. Cancelado libera espaço de volta.
 */
function agregarBoletosPorNf(boletos: { nf_id: number; valor: number; status: string }[]): Map<number, { alocado: number; liquidado: number }> {
  const mapa = new Map<number, { alocado: number; liquidado: number }>();
  for (const b of boletos) {
    if (b.status === "cancelado") continue;
    const atual = mapa.get(b.nf_id) || { alocado: 0, liquidado: 0 };
    atual.alocado += Number(b.valor) || 0;
    if (b.status === "pago") atual.liquidado += Number(b.valor) || 0;
    mapa.set(b.nf_id, atual);
  }
  return mapa;
}

function calcularSaldo(nf: NfVenda, agg: { alocado: number; liquidado: number } | undefined): NfVendaComSaldo {
  const emitido = Number(nf.valor) || 0;
  const alocado = agg?.alocado ?? 0;
  const liquidado = agg?.liquidado ?? 0;
  const disponivel = Math.max(0, Number((emitido - alocado).toFixed(2)));
  const situacao: NfVendaComSaldo["situacao"] = alocado <= 0 ? "nao_utilizada" : disponivel <= 0 ? "utilizada" : "parcial";
  return { ...nf, emitido, liquidado, disponivel, situacao };
}

/**
 * Lista as NFs já com emitido/liquidado/disponível calculados. Filtro opcional
 * pela situação computada (não pelo status bruto do banco, que só marca "já
 * teve alguma divisão" — quem decide se ainda cabe mais boleto é o saldo).
 */
export async function listarNfsVendaComSaldo(situacaoFiltro?: NfVendaComSaldo["situacao"]): Promise<NfVendaComSaldo[]> {
  const [nfsResp, boletosResp] = await Promise.all([
    supabase.from("nfs_venda").select("*").order("data", { ascending: false }).order("created_at", { ascending: false }),
    supabase.from("boletos_venda").select("nf_id, valor, status"),
  ]);
  if (nfsResp.error) throw nfsResp.error;
  if (boletosResp.error) throw boletosResp.error;

  const agregados = agregarBoletosPorNf(boletosResp.data ?? []);
  const comSaldo = (nfsResp.data ?? []).map((nf: NfVenda) => calcularSaldo(nf, agregados.get(nf.id)));

  return situacaoFiltro ? comSaldo.filter((nf) => nf.situacao === situacaoFiltro) : comSaldo;
}

/** Saldo de uma NF específica — usado pra validar uma divisão nova antes de gravar. */
export async function saldoDaNf(nfId: number): Promise<NfVendaComSaldo | null> {
  const nf = await buscarNfVendaPorId(nfId);
  if (!nf) return null;
  const boletos = await listarBoletosPorNf(nfId);
  const agregados = agregarBoletosPorNf(boletos);
  return calcularSaldo(nf, agregados.get(nfId));
}

export async function buscarNfVendaPorId(id: number): Promise<NfVenda | null> {
  const { data, error } = await supabase.from("nfs_venda").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as NfVenda) ?? null;
}

/**
 * Grava uma divisão (parcial ou não) de uma NF em N boletos, ligada a um
 * relatório de solicitação novo (numeração sequencial = id da linha) — assim
 * cada divisão tem seu próprio relatório, mesmo quando a mesma NF é dividida
 * mais de uma vez (saldo restante, boleto cancelado que abriu espaço, etc).
 * Quem chama já validou o saldo disponível antes (ver saldoDaNf).
 * Cria o relatório primeiro pra poder já ligar os boletos a ele.
 */
export async function dividirNfEmBoletos(
  nfId: number,
  numeroNf: string,
  itens: { banco: string | null; valor: number }[],
): Promise<{ boletos: BoletoVenda[]; relatorioId: number }> {
  const { data: relatorio, error: errRel } = await supabase
    .from("relatorios_solicitacao")
    .insert({ nf_id: nfId })
    .select()
    .single();
  if (errRel) throw errRel;

  const seuNumeroBase = `NF${String(numeroNf).padStart(3, "0")}`;

  const paraInserir = itens.map((it) => ({
    nf_id: nfId,
    relatorio_id: relatorio.id,
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

  // Só um indicativo histórico ("já teve divisão alguma vez") — quem decide
  // se ainda cabe dividir de novo é o saldo (situacao), não esse campo.
  const { error: errStatus } = await supabase
    .from("nfs_venda")
    .update({ status: "dividida" })
    .eq("id", nfId);
  if (errStatus) throw errStatus;

  return { boletos: (boletos ?? []) as BoletoVenda[], relatorioId: relatorio.id };
}

export async function buscarRelatorioPorId(id: number): Promise<{ id: number; nf_id: number } | null> {
  const { data, error } = await supabase.from("relatorios_solicitacao").select("id, nf_id").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** Lista boletos de venda, mais recentes primeiro. Filtro opcional por status. */
export async function listarBoletosVenda(status?: "aberto" | "pago" | "nao_conciliado" | "cancelado"): Promise<
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

/** Boletos de uma NF específica (de todas as divisões já feitas) — usado no painel da NF. */
export async function listarBoletosPorNf(nfId: number): Promise<BoletoVenda[]> {
  const { data, error } = await supabase.from("boletos_venda").select("*").eq("nf_id", nfId);
  if (error) throw error;
  return (data ?? []) as BoletoVenda[];
}

/** Boletos de uma divisão (relatório) específica — usado pra montar o PDF/XLSX daquela divisão. */
export async function listarBoletosPorRelatorio(relatorioId: number): Promise<BoletoVenda[]> {
  const { data, error } = await supabase.from("boletos_venda").select("*").eq("relatorio_id", relatorioId);
  if (error) throw error;
  return (data ?? []) as BoletoVenda[];
}

/**
 * Cancela um boleto AINDA EM ABERTO (nunca um já pago) pra liberar de volta o
 * saldo disponível da NF. O .eq("status","aberto") é o guarda real — se o
 * boleto já tiver sido pago ou cancelado antes, não acha a linha e ok=false.
 */
export async function cancelarBoleto(id: number): Promise<{ ok: boolean }> {
  const { data, error } = await supabase
    .from("boletos_venda")
    .update({ status: "cancelado" })
    .eq("id", id)
    .eq("status", "aberto")
    .select()
    .maybeSingle();
  if (error) throw error;
  return { ok: !!data };
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
