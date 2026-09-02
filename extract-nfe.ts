import { XMLParser } from "fast-xml-parser";

export interface DadosNFe {
  numeroNf: string | null;
  cnpj: string | null;
  cliente: string | null;
  valor: number | null;
  dataEmissao: string | null; // YYYY-MM-DD
}

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

/**
 * Procura a primeira ocorrência de uma chave em qualquer nível do objeto
 * (o XML da NF-e pode vir como <nfeProc><NFe>...</NFe></nfeProc> — já
 * "processado", com protocolo de autorização — ou só <NFe>...</NFe> direto.
 * Em vez de decorar os dois caminhos, procura em qualquer profundidade.
 */
function buscar(obj: any, chave: string): any {
  if (obj == null || typeof obj !== "object") return undefined;
  if (chave in obj) return obj[chave];
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const achado = buscar(v, chave);
      if (achado !== undefined) return achado;
    }
  }
  return undefined;
}

/** Extrai os dados relevantes do XML de uma NF-e (nota de venda). */
export function extrairXmlNFe(xml: string): DadosNFe {
  try {
    const obj = parser.parse(xml);

    const infNFe = buscar(obj, "infNFe");
    const ide = buscar(infNFe ?? obj, "ide");
    const dest = buscar(infNFe ?? obj, "dest");
    const icmsTot = buscar(infNFe ?? obj, "ICMSTot");

    const numeroNf = ide?.nNF != null ? String(ide.nNF) : null;

    // dhEmi (layout novo, com hora e timezone) ou dEmi (layout antigo) — os dois em YYYY-MM-DD...
    const dhEmi: string | undefined = ide?.dhEmi ?? ide?.dEmi;
    const dataEmissao = dhEmi ? dhEmi.slice(0, 10) : null;

    const cnpjRaw = dest?.CNPJ ?? dest?.CPF ?? null;
    const cnpj = cnpjRaw != null ? String(cnpjRaw) : null;
    const cliente = dest?.xNome != null ? String(dest.xNome) : null;

    const vNF = icmsTot?.vNF;
    const valor = vNF != null && !Number.isNaN(Number(vNF)) ? Number(vNF) : null;

    return { numeroNf, cnpj, cliente, valor, dataEmissao };
  } catch (e) {
    console.error("[extract-nfe] falha ao parsear XML:", e);
    return { numeroNf: null, cnpj: null, cliente: null, valor: null, dataEmissao: null };
  }
}
