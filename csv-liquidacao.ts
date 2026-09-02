import { boletosEmAberto, marcarBoletoPago, salvarConciliacoesPendentes, type BoletoVenda } from "./vendas.js";
import { dataSP } from "./util.js";

export interface LinhaLiquidacao {
  pagador: string | null;
  valor: number | null;
  seuNumero: string | null;
}

export interface ResultadoConciliacao {
  conciliados: number;
  naoConciliados: number;
}

function detectarDelimitador(linhaCabecalho: string): string {
  const pontoEVirgula = linhaCabecalho.match(/;/g)?.length ?? 0;
  const virgula = linhaCabecalho.match(/,/g)?.length ?? 0;
  return pontoEVirgula >= virgula ? ";" : ",";
}

/** Divide uma linha de CSV respeitando campos entre aspas (que podem conter o delimitador). */
function dividirLinhaCsv(linha: string, delim: string): string[] {
  const campos: string[] = [];
  let atual = "";
  let dentroAspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      dentroAspas = !dentroAspas;
      continue;
    }
    if (c === delim && !dentroAspas) {
      campos.push(atual.trim());
      atual = "";
      continue;
    }
    atual += c;
  }
  campos.push(atual.trim());
  return campos;
}

function normalizaCabecalho(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

/** "1.234,56" ou "100,00" -> 1234.56 / 100. Também aceita "1234.56" (formato US) como fallback. */
function parseValorBR(s: string | undefined): number | null {
  if (!s) return null;
  const limpo = s.replace(/[^\d,.\-]/g, "");
  if (!limpo) return null;
  const comPontoDecimal = limpo.includes(",") ? limpo.replace(/\./g, "").replace(",", ".") : limpo;
  const n = Number(comPontoDecimal);
  return Number.isFinite(n) ? n : null;
}

/**
 * Interpreta o CSV da folha de liquidações. Cabeçalho esperado tem colunas
 * com "pagador", "valor" e "seu número" (ou "número") no nome — a procura é
 * por conteúdo, não posição fixa, pra tolerar variação de layout do banco.
 */
export function parseCsvLiquidacao(conteudo: string): LinhaLiquidacao[] {
  const linhas = conteudo.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (linhas.length < 2) return [];

  const delim = detectarDelimitador(linhas[0]);
  const cabecalho = dividirLinhaCsv(linhas[0], delim).map(normalizaCabecalho);

  const idxPagador = cabecalho.findIndex((c) => c.includes("pagador"));
  const idxValor = cabecalho.findIndex((c) => c.includes("valor"));
  const idxSeuNumeroEspecifico = cabecalho.findIndex((c) => c.includes("seu") && c.includes("numero"));
  const idxSeuNumero = idxSeuNumeroEspecifico >= 0 ? idxSeuNumeroEspecifico : cabecalho.findIndex((c) => c.includes("numero"));

  const resultado: LinhaLiquidacao[] = [];
  for (let i = 1; i < linhas.length; i++) {
    const campos = dividirLinhaCsv(linhas[i], delim);
    resultado.push({
      pagador: idxPagador >= 0 ? campos[idxPagador] || null : null,
      valor: idxValor >= 0 ? parseValorBR(campos[idxValor]) : null,
      seuNumero: idxSeuNumero >= 0 ? campos[idxSeuNumero] || null : null,
    });
  }
  return resultado;
}

/**
 * Casa cada linha do CSV com um boleto em aberto (por seu_numero + valor).
 * Bate: dá baixa no boleto (status="pago", data=hoje). Não bate: vira uma
 * conciliação pendente pra revisão manual — nunca é descartada silenciosamente.
 */
export async function conciliarLiquidacao(conteudoCsv: string): Promise<ResultadoConciliacao> {
  const linhas = parseCsvLiquidacao(conteudoCsv);
  const abertos = await boletosEmAberto();

  // chave de casamento: seu_numero (case/trim insensível) + valor (2 casas decimais)
  const chave = (seuNumero: string | null | undefined, valor: number | null | undefined) =>
    `${(seuNumero || "").trim().toLowerCase()}|${valor != null ? valor.toFixed(2) : ""}`;

  const mapaAbertos = new Map<string, BoletoVenda>();
  for (const b of abertos) mapaAbertos.set(chave(b.seu_numero, b.valor), b);

  const hoje = dataSP();
  let conciliados = 0;
  const naoConciliadas: LinhaLiquidacao[] = [];

  for (const linha of linhas) {
    const boleto = mapaAbertos.get(chave(linha.seuNumero, linha.valor));
    if (boleto) {
      await marcarBoletoPago(boleto.id, hoje);
      mapaAbertos.delete(chave(linha.seuNumero, linha.valor)); // evita casar 2 linhas do CSV com o mesmo boleto
      conciliados++;
    } else {
      naoConciliadas.push(linha);
    }
  }

  await salvarConciliacoesPendentes(
    naoConciliadas.map((l) => ({ pagador: l.pagador, valor: l.valor, seu_numero: l.seuNumero })),
  );

  return { conciliados, naoConciliados: naoConciliadas.length };
}
