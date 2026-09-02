// Interpreta o texto livre que a pessoa digita ao dividir uma NF em boletos,
// ex: "2 boletos banco itau valores 100,00 e 45,00".
// Não tenta ser esperto demais: extrai os valores em dinheiro do texto (essa
// é a parte que não pode falhar) e tenta achar o nome do banco por uma lista
// conhecida. O resultado volta pro front como uma prévia editável — a pessoa
// confirma ou corrige antes de gravar (nunca salva direto do texto puro).

export interface DivisaoParseada {
  banco: string | null;
  valores: number[];
  quantidadeDitas: number | null; // o "2" de "2 boletos", só pra checagem/aviso
  avisos: string[];
}

const BANCOS_CONHECIDOS = [
  "itau", "itaú", "bradesco", "santander", "banco do brasil", "bb",
  "caixa", "caixa economica", "caixa econômica", "sicoob", "sicredi",
  "inter", "nubank", "nu", "safra", "original", "c6", "c6 bank",
  "btg", "banrisul", "votorantim",
];

function normaliza(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // remove acentos (marcas combinantes deixadas pelo NFD)
}

/** Extrai todos os valores em dinheiro do texto (formato brasileiro: 1.234,56 ou 100,00). */
function extrairValores(texto: string): number[] {
  const matches = texto.match(/\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}/g) || [];
  return matches.map((m) => Number(m.replace(/\./g, "").replace(",", ".")));
}

function extrairBanco(textoNormalizado: string): string | null {
  // tenta achar "banco X" primeiro (mais preciso)
  const m = textoNormalizado.match(/banco\s+([a-z0-9çãõáéíóú ]+?)(?:\s+valor|\s+valores|,|$)/i);
  if (m) {
    const candidato = m[1].trim();
    if (candidato) return candidato;
  }
  // senão, procura qualquer nome de banco conhecido solto no texto
  for (const b of BANCOS_CONHECIDOS) {
    if (textoNormalizado.includes(normaliza(b))) return b;
  }
  return null;
}

function extrairQuantidadeDita(textoNormalizado: string): number | null {
  const m = textoNormalizado.match(/(\d+)\s*boletos?/);
  return m ? Number(m[1]) : null;
}

export function parseDivisao(texto: string): DivisaoParseada {
  const norm = normaliza(texto);
  const valores = extrairValores(texto);
  const banco = extrairBanco(texto);
  const quantidadeDitas = extrairQuantidadeDita(norm);

  const avisos: string[] = [];
  if (valores.length === 0) {
    avisos.push("Não encontrei nenhum valor em dinheiro no texto (ex: 100,00). Confira e reescreva.");
  }
  if (quantidadeDitas != null && quantidadeDitas !== valores.length) {
    avisos.push(
      `Você disse "${quantidadeDitas} boletos" mas encontrei ${valores.length} valor(es). Confira antes de confirmar.`,
    );
  }
  if (!banco) {
    avisos.push("Não identifiquei o banco — pode preencher manualmente antes de confirmar.");
  }

  return { banco, valores, quantidadeDitas, avisos };
}
