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
  // Conta cada candidato no cabeçalho e usa o que aparece mais vezes.
  // Tab entra na lista porque exportação de banco/planilha às vezes vem
  // assim mesmo com extensão .csv (dá pra abrir normal no Excel de qualquer
  // jeito, então quem só olhou no Excel não teria como notar).
  const candidatos: [string, RegExp][] = [
    [";", /;/g],
    [",", /,/g],
    ["\t", /\t/g],
    ["|", /\|/g],
  ];
  let melhor = ";";
  let melhorContagem = -1;
  for (const [delim, re] of candidatos) {
    const contagem = linhaCabecalho.match(re)?.length ?? 0;
    if (contagem > melhorContagem) {
      melhor = delim;
      melhorContagem = contagem;
    }
  }
  return melhorContagem > 0 ? melhor : ";";
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
  if (linhas.length < 2) {
    console.warn(`[csv-liquidacao] arquivo com ${linhas.length} linha(s) útil(eis) — nada pra processar`);
    return [];
  }

  const delim = detectarDelimitador(linhas[0]);
  const cabecalhoOriginal = dividirLinhaCsv(linhas[0], delim);
  const cabecalho = cabecalhoOriginal.map(normalizaCabecalho);

  // /n.?mero/ (com o "?") pega "numero" já normalizado, mas também "número" cru
  // se a normalização de acento falhar por causa de encoding estranho no
  // arquivo (comum em exportação de banco) — o "." aceita 1 caractere qualquer
  // (ou nenhum, com o "?") no lugar do "ú" sem sair batendo com qualquer coisa.
  const pareceNumero = (c: string) => c.includes("numero") || /n.?mero/i.test(c);

  const idxPagador = cabecalho.findIndex((c) => c.includes("pagador") || c.includes("sacado"));
  const idxValor = cabecalho.findIndex((c) => c.includes("valor"));
  const idxSeuNumeroEspecifico = cabecalho.findIndex((c) => c.includes("seu") && pareceNumero(c));
  const idxSeuNumero = idxSeuNumeroEspecifico >= 0 ? idxSeuNumeroEspecifico : cabecalho.findIndex(pareceNumero);

  // Log de diagnóstico: sem isso, uma coluna não reconhecida (nome diferente do
  // esperado, acento corrompido por encoding, etc.) faz TODAS as linhas caírem
  // em "não conciliado" sem deixar pista nenhuma de por quê.
  console.log(
    `[csv-liquidacao] delimitador="${delim}" cabecalho=${JSON.stringify(cabecalhoOriginal)} ` +
      `-> pagador=col[${idxPagador}] valor=col[${idxValor}] seuNumero=col[${idxSeuNumero}]`,
  );
  if (idxPagador < 0 || idxValor < 0 || idxSeuNumero < 0) {
    console.warn(
      "[csv-liquidacao] AVISO: não achei uma ou mais colunas esperadas (pagador/valor/seu número) " +
        "no cabeçalho acima — essas linhas vão vir com o campo faltando e NÃO vão casar com boleto nenhum.",
    );
  }

  const resultado: LinhaLiquidacao[] = [];
  for (let i = 1; i < linhas.length; i++) {
    const campos = dividirLinhaCsv(linhas[i], delim);
    const linha = {
      pagador: idxPagador >= 0 ? campos[idxPagador] || null : null,
      valor: idxValor >= 0 ? parseValorBR(campos[idxValor]) : null,
      seuNumero: idxSeuNumero >= 0 ? campos[idxSeuNumero] || null : null,
    };
    if (i === 1) console.log(`[csv-liquidacao] exemplo primeira linha interpretada: ${JSON.stringify(linha)} (bruta: ${JSON.stringify(campos)})`);
    resultado.push(linha);
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

  console.log(
    `[csv-liquidacao] ${linhas.length} linha(s) no csv, ${abertos.length} boleto(s) em aberto. ` +
      `chaves em aberto: ${JSON.stringify([...mapaAbertos.keys()])}`,
  );

  const hoje = dataSP();
  let conciliados = 0;
  const naoConciliadas: LinhaLiquidacao[] = [];

  for (const linha of linhas) {
    const chaveLinha = chave(linha.seuNumero, linha.valor);
    const boleto = mapaAbertos.get(chaveLinha);
    if (boleto) {
      await marcarBoletoPago(boleto.id, hoje);
      mapaAbertos.delete(chaveLinha); // evita casar 2 linhas do CSV com o mesmo boleto
      conciliados++;
    } else {
      console.log(`[csv-liquidacao] não casou: linha=${JSON.stringify(linha)} chave="${chaveLinha}"`);
      naoConciliadas.push(linha);
    }
  }

  await salvarConciliacoesPendentes(
    naoConciliadas.map((l) => ({ pagador: l.pagador, valor: l.valor, seu_numero: l.seuNumero })),
  );

  return { conciliados, naoConciliados: naoConciliadas.length };
}
