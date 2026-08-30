import { comprovantesDoDia } from "./supabase.js";
import { dataSP, dataBR, brl } from "./util.js";

export interface Relatorio {
  texto: string;
  total: number;
  quantidade: number;
  data: string;
}

/** Monta o relatório do dia: total + cada valor listado. */
export async function gerarRelatorio(data: string = dataSP()): Promise<Relatorio> {
  const rows = await comprovantesDoDia(data);
  const lidos = rows.filter((r) => r.valor != null);
  const naoLidos = rows.filter((r) => r.valor == null);

  const total = lidos.reduce((s, r) => s + Number(r.valor), 0);

  const linhas = lidos.map((r, i) => `${i + 1}. ${brl(Number(r.valor))}`).join("\n");
  const revisar = naoLidos.length
    ? `\n\n⚠️ ${naoLidos.length} comprovante(s) não lido(s) — revisar na planilha.`
    : "";

  const texto = `📊 Relatório de comprovantes — ${dataBR(data)}

${linhas || "Nenhum comprovante lido hoje."}

Total: ${brl(total)} (${lidos.length} comprovante${lidos.length === 1 ? "" : "s"})${revisar}`;

  return { texto, total, quantidade: lidos.length, data };
}
