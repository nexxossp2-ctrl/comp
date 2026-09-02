import express from "express";
import path from "path";
import cron from "node-cron";
import { createHash } from "crypto";
import archiver from "archiver";
import { extrairBase64, baixarBase64, type Extracao } from "./extract.js";
import { salvarComprovante, listarComprovantes, subirArquivo, linkAssinado, comprovantesPorIds, baixarArquivo, excluirComprovante } from "./supabase.js";
import { gerarPDF, gerarXLSX, type ItemRelatorio } from "./relatorio-arquivo.js";
import { gerarRelatorio } from "./report.js";
import { enviarEmail, enviarWhatsapp, enviarEmailComAnexos } from "./send.js";
import { dataSP, dataBR } from "./util.js";
import { extrairXmlNFe } from "./extract-nfe.js";
import { parseDivisao } from "./parse-divisao.js";
import { conciliarLiquidacao } from "./csv-liquidacao.js";
import {
  salvarNfVenda,
  subirArquivoXmlVenda,
  listarNfsVenda,
  buscarNfVendaPorId,
  dividirNfEmBoletos,
  listarBoletosVenda,
  listarBoletosPorNf,
  listarConciliacoesPendentes,
  resolverConciliacaoPendente,
  buscarRelatorioPorId,
} from "./vendas.js";
import { gerarPDFBoletos, gerarXLSXBoletos, type ItemRelatorioBoleto } from "./relatorio-boletos.js";

const app = express();
app.use(express.json({ limit: "25mb" }));
// Serve arquivos estáticos da pasta public/ (ex: /dashboard-geral.html)
app.use(express.static(path.join(process.cwd(), "public")));

const GRUPO_ID = (process.env.GRUPO_ID || "").trim();
// Grupo separado, só pra NFs de venda (contas a receber) — módulo NF/Boletos.
// Documento chegando nesse grupo NUNCA passa pelo fluxo de comprovantes/boletos
// a pagar; vai direto pro processamento de XML de NF-e.
const GRUPO_ID_VENDAS = (process.env.GRUPO_ID_VENDAS || "").trim();

type ResultadoProc =
  | { status: "salvo"; tipo: "pago" | "solicitado"; valor: number | null; beneficiario: string | null }
  | { status: "ignorado" }
  | { status: "duplicado" };

/**
 * Processamento único usado pelo WhatsApp e pelo upload:
 * classifica pago/boleto/outro, deduplica e grava no banco (Supabase).
 * - tipo "pago": comprovante de pagamento já feito.
 * - tipo "boleto": cobrança/fatura em aberto — vira uma "solicitação" (status="solicitado").
 * - tipo "outro": não é documento financeiro, é descartado (não grava nada).
 */
async function salvarProcessado(
  ex: Extracao,
  meta: { identificador: string; remetente: string; data: string; fileName?: string | null; mime: string; base64?: string },
): Promise<ResultadoProc> {
  if (ex.tipo === "outro") {
    console.log(`[ignorado] ${meta.identificador} não é comprovante nem boleto`);
    return { status: "ignorado" };
  }

  const status: "pago" | "solicitado" = ex.tipo === "pago" ? "pago" : "solicitado";

  // Impressão digital do pagamento: data+hora+valor lidos do comprovante.
  // Só monta se tiver os três — senão fica null e não bloqueia nada.
  const fingerprint =
    ex.data_pagamento && ex.hora_pagamento && ex.valor != null
      ? `${ex.data_pagamento}|${ex.hora_pagamento}|${ex.valor}`
      : null;

  // Sobe o arquivo pro Storage (se veio o conteúdo). Guarda o caminho.
  const arquivo_url = meta.base64
    ? await subirArquivo(meta.base64, meta.mime, meta.identificador)
    : null;

  // Data do registro: data de pagamento (pago), vencimento (boleto) — se vierem válidas;
  // senão cai pra data de chegada da mensagem.
  const dataCandidata = status === "pago" ? ex.data_pagamento : ex.data_vencimento;
  const dataValida = /^\d{4}-\d{2}-\d{2}$/.test(dataCandidata || "");
  const dataFinal = dataValida ? (dataCandidata as string) : meta.data;

  let inserido: boolean;
  try {
    inserido = await salvarComprovante({
      message_id: meta.identificador,
      valor: ex.valor,
      data: dataFinal,
      status,
      vencimento: status === "solicitado" ? ex.data_vencimento : null,
      beneficiario: ex.beneficiario,
      remetente: meta.remetente,
      fingerprint,
      arquivo_url,
      file_name: meta.fileName ?? null,
      mime_type: meta.mime,
      raw_valor: ex.raw,
      doc_tipo: ex.tipo,
      numero_nf: ex.numero_nf,
    });
  } catch (e) {
    console.error(`[supabase] falha ao salvar ${meta.identificador}:`, e);
    // Sem isso, uma falha real do Supabase (fora de ar, chave errada, etc.)
    // só aparecia no log do Railway — ninguém ficava sabendo que um
    // comprovante recebido não tinha sido salvo. Best-effort: se o próprio
    // aviso falhar, só loga — não pode mascarar o erro original.
    try {
      await enviarWhatsapp(
        `⚠️ Falha ao salvar comprovante de ${meta.remetente || "remetente desconhecido"} ` +
          `(id ${meta.identificador}). Pode ter que pedir pra reenviar. Erro: ${String(e).slice(0, 200)}`,
      );
    } catch (alertErr) {
      console.error("[alerta] falha ao enviar aviso de WhatsApp:", alertErr);
    }
    throw e;
  }

  if (!inserido) {
    console.log(`[dup] ${meta.identificador} já processado, ignorado`);
    return { status: "duplicado" };
  }

  console.log(`[ok] ${meta.identificador} status=${status} valor=${ex.valor ?? "null"} data=${dataFinal} (chegada=${meta.data})`);
  return { status: "salvo", tipo: status, valor: ex.valor, beneficiario: ex.beneficiario };
}

/**
 * Decide se a mensagem tem um arquivo de comprovante (PDF ou imagem)
 * e devolve a URL + mimeType. Cobre os dois caminhos:
 *  - document (PDF, ou JPEG enviado como arquivo)
 *  - image (JPEG/PNG enviado como foto)
 */
function extrairArquivo(body: any): { url: string; mime: string; fileName?: string } | null {
  const doc = body.document;
  if (doc?.documentUrl) {
    const mime = (doc.mimeType || "").toLowerCase();
    if (mime.includes("pdf") || mime.includes("jpeg") || mime.includes("png")) {
      return { url: doc.documentUrl, mime, fileName: doc.fileName };
    }
  }
  const img = body.image;
  if (img?.imageUrl) {
    return { url: img.imageUrl, mime: (img.mimeType || "image/jpeg").toLowerCase() };
  }
  return null;
}

/** Igual extrairArquivo, mas só pra XML — usado no grupo de vendas (NF de venda vem em XML). */
function extrairArquivoXml(body: any): { url: string; fileName?: string } | null {
  const doc = body.document;
  if (!doc?.documentUrl) return null;
  const mime = (doc.mimeType || "").toLowerCase();
  const nome = (doc.fileName || "").toLowerCase();
  if (mime.includes("xml") || nome.endsWith(".xml")) {
    return { url: doc.documentUrl, fileName: doc.fileName };
  }
  return null;
}

/**
 * Processa uma NF de venda: baixa o XML, extrai os dados e salva. Usado tanto
 * pelo grupo do WhatsApp dedicado a vendas quanto pelo upload manual.
 */
async function processarNfVenda(
  xmlTexto: string,
  meta: { identificador: string; fileName?: string | null; arquivoUrl: string | null; dataChegada: string },
): Promise<{ status: "salvo"; nf: Awaited<ReturnType<typeof salvarNfVenda>> } | { status: "ignorado"; motivo: string } | { status: "duplicado" }> {
  const dados = extrairXmlNFe(xmlTexto);

  if (!dados.numeroNf) {
    console.log(`[vendas][ignorado] ${meta.identificador} não parece um XML de NF-e válido`);
    return { status: "ignorado", motivo: "Não consegui ler um número de NF nesse XML. Confira se é o arquivo certo." };
  }

  const dataValida = /^\d{4}-\d{2}-\d{2}$/.test(dados.dataEmissao || "");
  const dataFinal = dataValida ? (dados.dataEmissao as string) : meta.dataChegada;

  let nf;
  try {
    nf = await salvarNfVenda({
      message_id: meta.identificador,
      numero_nf: dados.numeroNf,
      cnpj: dados.cnpj,
      cliente: dados.cliente,
      valor: dados.valor,
      data: dataFinal,
      arquivo_url: meta.arquivoUrl,
      file_name: meta.fileName ?? null,
    });
  } catch (e) {
    console.error(`[vendas] falha ao salvar NF ${meta.identificador}:`, e);
    throw e;
  }

  if (!nf) {
    console.log(`[vendas][dup] ${meta.identificador} já processado`);
    return { status: "duplicado" };
  }

  console.log(`[vendas][ok] NF ${dados.numeroNf} cliente=${dados.cliente || "?"} valor=${dados.valor ?? "null"} data=${dataFinal}`);
  return { status: "salvo", nf };
}

// Token de segurança que o Z-API manda no header de cada webhook.
// Se WEBHOOK_TOKEN estiver configurado, exige que o header bata.
const WEBHOOK_TOKEN = (process.env.WEBHOOK_TOKEN || "").trim();

function tokenValido(req: express.Request): boolean {
  if (!WEBHOOK_TOKEN) return true; // sem token configurado, não bloqueia (retrocompatível)
  // O Z-API envia o token nos webhooks no header "z-api-token"
  // (apesar de exigir "Client-Token" nas chamadas que fazemos a ele).
  const recebido = String(
    req.header("z-api-token") || req.header("Client-Token") || "",
  ).trim();
  return recebido === WEBHOOK_TOKEN;
}

app.post("/webhook", async (req, res) => {
  // Responde 200 rápido pro Z-API não reenviar. Processa depois.
  res.sendStatus(200);

  if (!tokenValido(req)) {
    console.warn("[webhook] rejeitado: Client-Token inválido ou ausente");
    return;
  }

  try {
    const body = req.body;

    // Só grupo (e, se configurado, só o grupo alvo)
    if (!body?.isGroup) return;

    // Log de descoberta: mostra id e nome de todo grupo que manda mensagem.
    console.log(`[recebido] grupo=${body.phone} nome=${body.chatName || "(sem nome)"}`);

    const phoneRecebido = String(body.phone || "").trim();

    // Grupo de vendas: fluxo totalmente separado (NF de venda em XML, não
    // comprovante/boleto a pagar). Sai daqui, nunca cai no fluxo de baixo.
    if (GRUPO_ID_VENDAS && phoneRecebido === GRUPO_ID_VENDAS) {
      const arquivoXml = extrairArquivoXml(body);
      if (!arquivoXml) return; // texto, imagem, etc — ignora
      const messageId: string = body.messageId;
      if (!messageId) return;

      const data = dataSP(body.momment ?? Date.now());
      const resXml = await fetch(arquivoXml.url);
      if (!resXml.ok) {
        console.error(`[vendas] falha ao baixar xml (${resXml.status})`);
        return;
      }
      const xmlTexto = await resXml.text();
      const arquivoUrl = await subirArquivoXmlVenda(xmlTexto, messageId);

      await processarNfVenda(xmlTexto, {
        identificador: messageId,
        fileName: arquivoXml.fileName ?? null,
        arquivoUrl,
        dataChegada: data,
      });
      return;
    }

    if (GRUPO_ID && phoneRecebido !== GRUPO_ID) {
      console.log(
        `[filtro] rejeitado. recebido="${phoneRecebido}" (len ${phoneRecebido.length}) ` +
          `| esperado="${GRUPO_ID}" (len ${GRUPO_ID.length})`,
      );
      return;
    }

    const arquivo = extrairArquivo(body);
    if (!arquivo) return; // texto, áudio, figurinha, notificação — ignora

    const messageId: string = body.messageId;
    if (!messageId) return;

    const data = dataSP(body.momment ?? Date.now());
    const remetente: string = body.senderName || body.chatName || body.participantPhone || "";

    const { data: base64 } = await baixarBase64(arquivo.url);
    const ex = await extrairBase64(base64, arquivo.mime);
    await salvarProcessado(ex, {
      identificador: messageId,
      remetente,
      data,
      fileName: arquivo.fileName ?? null,
      mime: arquivo.mime,
      base64,
    });
  } catch (err) {
    console.error("[erro webhook]", err);
  }
});

// Senha do dashboard. Se DASHBOARD_SENHA estiver setada, a API exige o header.
const DASHBOARD_SENHA = (process.env.DASHBOARD_SENHA || "").trim();

function autorizadoDashboard(req: express.Request): boolean {
  if (!DASHBOARD_SENHA) return true; // sem senha configurada, fica aberto
  const recebido = String(req.header("X-Senha") || req.query.senha || "").trim();
  return recebido === DASHBOARD_SENHA;
}

/**
 * Baixa os arquivos dos comprovantes selecionados (pelos ids), com nomes únicos
 * e amigáveis (data_beneficiario). Usado tanto pelo ZIP de download quanto pelo
 * envio por email dos comprovantes originais (não confundir com o "relatório",
 * que é um PDF/XLSX resumindo os dados — aqui são os arquivos originais).
 */
async function baixarAnexosDosComprovantes(
  ids: string[],
): Promise<{ filename: string; content: Buffer }[]> {
  const rows = await comprovantesPorIds(ids);
  const comArquivo = rows.filter((r) => r.arquivo_url);

  const usados = new Set<string>();
  const anexos: { filename: string; content: Buffer }[] = [];
  for (const r of comArquivo) {
    const buf = await baixarArquivo(r.arquivo_url as string);
    if (!buf) continue;
    const ext = (r.arquivo_url as string).split(".").pop() || "jpg";
    const base = `${r.data}_${(r.beneficiario || "comprovante").replace(/[^\w\-]+/g, "-")}`;
    let nome = `${base}.${ext}`;
    let i = 2;
    while (usados.has(nome)) nome = `${base}-${i++}.${ext}`;
    usados.add(nome);
    anexos.push({ filename: nome, content: buf });
  }
  return anexos;
}

// API pro dashboard (v0). Read-only: só devolve dados, não edita nada.
app.options("/api/comprovantes", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Senha");
  res.sendStatus(204);
});

// Download em lote: recebe { ids: [...] } e devolve um ZIP com os arquivos.
app.options("/api/download", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Senha");
  res.sendStatus(204);
});

app.post("/api/download", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (!autorizadoDashboard(req)) {
    return res.status(401).json({ erro: "não autorizado" });
  }
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ erro: "nenhum comprovante selecionado" });

    const anexos = await baixarAnexosDosComprovantes(ids);
    if (anexos.length === 0) {
      return res.status(404).json({ erro: "nenhum arquivo disponível para os selecionados" });
    }

    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="comprovantes.zip"`);

    const zip = archiver("zip", { zlib: { level: 9 } });
    zip.on("error", (e: Error) => {
      console.error("[download] erro no zip:", e);
      try { res.status(500).end(); } catch {}
    });
    zip.pipe(res);

    for (const a of anexos) zip.append(a.content, { name: a.filename });

    await zip.finalize();
  } catch (e) {
    console.error("[download] erro:", e);
    if (!res.headersSent) res.status(500).json({ erro: String(e) });
  }
});

// Envia os ARQUIVOS ORIGINAIS dos comprovantes selecionados por email (anexados
// direto, um por um) — diferente do "/api/relatorio", que manda um PDF/XLSX
// resumindo os dados. Aqui é "encaminhar os comprovantes em si".
app.options("/api/enviar-comprovantes", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Senha");
  res.sendStatus(204);
});

app.post("/api/enviar-comprovantes", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (!autorizadoDashboard(req)) {
    return res.status(401).json({ erro: "não autorizado" });
  }
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const email: string = String(req.body?.email || "").trim();
    if (ids.length === 0) return res.status(400).json({ erro: "nenhum comprovante selecionado" });
    if (!email) return res.status(400).json({ erro: "email de destino é obrigatório" });

    const anexos = await baixarAnexosDosComprovantes(ids);
    if (anexos.length === 0) {
      return res.status(404).json({ erro: "nenhum arquivo disponível para os selecionados" });
    }

    await enviarEmailComAnexos(
      email,
      "Comprovantes de pagamento",
      `Segue${anexos.length === 1 ? "" : "m"} em anexo ${anexos.length} comprovante${anexos.length === 1 ? "" : "s"}.`,
      anexos,
    );
    res.json({ ok: true, enviadoPara: email, quantidade: anexos.length });
  } catch (e) {
    console.error("[enviar-comprovantes] erro:", e);
    if (!res.headersSent) res.status(500).json({ erro: String(e) });
  }
});

app.get("/api/comprovantes", async (req, res) => {
  // CORS: precisa permitir o header de senha vindo do front.
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Senha");

  if (!autorizadoDashboard(req)) {
    return res.status(401).json({ erro: "não autorizado" });
  }
  try {
    const inicio = (req.query.inicio as string) || undefined;
    const fim = (req.query.fim as string) || undefined;
    const beneficiario = (req.query.beneficiario as string) || undefined;
    // Compatibilidade: sem "status" na query, comportamento é IDÊNTICO ao de antes
    // (só devolve o que já foi pago). "status=solicitado" pega só as cobranças em
    // aberto. "status=todos" devolve os dois tipos juntos (usado pelo dashboard-geral).
    const statusQuery = ((req.query.status as string) || "pago").toLowerCase();
    const status = statusQuery === "todos" ? undefined : statusQuery;

    const rows = await listarComprovantes({ inicio, fim, beneficiario, status });

    const comprovantes = await Promise.all(
      rows.map(async (r) => ({
        data: r.data,
        valor: r.valor,
        status: r.status,
        vencimento: r.vencimento,
        beneficiario: r.beneficiario,
        remetente: r.remetente,
        identificador: r.message_id,
        arquivo: r.arquivo_url ? await linkAssinado(r.arquivo_url) : null,
        // doc_tipo mais granular que status ("boleto" | "nf"); registros antigos (antes dessa
        // coluna existir) vêm null e o front trata como "boleto" pra manter compatibilidade.
        docTipo: r.doc_tipo || (r.status === "solicitado" ? "boleto" : r.status),
        numeroNf: r.numero_nf,
      })),
    );

    // CT-e não entra nas somas (total e por beneficiário): ele acompanha uma ou mais NFs
    // que já vão ser cobradas juntas num boleto consolidado — contar o CT-e também
    // duplicaria o valor daquele boleto. Continua na lista (fica visível pra consulta).
    const contaValor = (c: (typeof comprovantes)[number]) => c.docTipo !== "cte";

    const total = comprovantes.filter(contaValor).reduce((s, c) => s + (Number(c.valor) || 0), 0);

    // Soma agrupada por beneficiário
    const mapa = new Map<string, { total: number; quantidade: number }>();
    for (const c of comprovantes.filter(contaValor)) {
      const nome = c.beneficiario || "(sem beneficiário)";
      const atual = mapa.get(nome) || { total: 0, quantidade: 0 };
      atual.total += Number(c.valor) || 0;
      atual.quantidade += 1;
      mapa.set(nome, atual);
    }
    const porBeneficiario = [...mapa.entries()]
      .map(([beneficiario, v]) => ({ beneficiario, ...v }))
      .sort((a, b) => b.total - a.total);

    res.json({ comprovantes, total, quantidade: comprovantes.length, porBeneficiario });
  } catch (e) {
    console.error("[comprovantes] erro:", e);
    res.status(500).json({ erro: String(e) });
  }
});

// Alerta de desconexão do Z-API. Aponte o webhook "Ao desconectar" pra cá.
// Quando o número cai (deslogado ou trial vencido), chega um email.
app.post("/zapi-status", async (req, res) => {
  res.sendStatus(200);
  if (!tokenValido(req)) {
    console.warn("[zapi-status] rejeitado: Client-Token inválido ou ausente");
    return;
  }
  try {
    const body = req.body || {};
    // O Z-API manda evento de conexão/desconexão. Tratamos como alerta de queda.
    const conectado = body.connected === true;
    if (conectado) {
      console.log("[zapi-status] reconectou");
      return;
    }
    const quando = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    await enviarEmail(
      "⚠️ WhatsApp desconectado — comprovantes parados",
      `O número do Z-API desconectou em ${quando}.\n\n` +
        `Enquanto isso, nenhum comprovante está sendo capturado. ` +
        `Reconecte o número no painel do Z-API (escanear QR) o quanto antes.\n\n` +
        `Se for fim do período de teste, é preciso assinar o plano pra religar.`,
    );
    console.log("[zapi-status] desconexão detectada, email enviado");
  } catch (e) {
    console.error("[erro zapi-status]", e);
  }
});

// Upload manual de comprovante (usado pela página do dashboard).
// Recebe { file: base64, fileName, mime }. Passa pelo mesmo processamento.
app.post("/api/upload", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Senha");
  if (!autorizadoDashboard(req)) {
    return res.status(401).json({ erro: "não autorizado" });
  }
  try {
    const { file, fileName, mime } = req.body || {};
    if (!file || typeof file !== "string") {
      return res.status(400).json({ erro: "campo 'file' (base64) é obrigatório" });
    }
    // Aceita data URL ("data:...;base64,XXХХ") ou base64 puro.
    const base64 = file.includes(",") ? file.split(",")[1] : file;
    const tipo = (mime || "").toLowerCase() || (fileName?.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");

    const ex = await extrairBase64(base64, tipo);
    // Identificador = hash do conteúdo. Mesmo arquivo = mesmo id = dedupe pelo banco.
    const hash = createHash("sha256").update(base64).digest("hex").slice(0, 24);
    const identificador = `upload-${hash}`;

    const r = await salvarProcessado(ex, {
      identificador,
      remetente: "upload manual",
      data: dataSP(),
      fileName: fileName ?? null,
      mime: tipo,
      base64,
    });

    if (r.status === "ignorado") {
      return res.status(200).json({ ok: false, motivo: "Não é comprovante de pagamento (boleto ou outro documento)." });
    }
    if (r.status === "duplicado") {
      return res.status(200).json({ ok: false, motivo: "Este comprovante já foi enviado antes." });
    }
    return res.json({ ok: true, valor: ex.valor, beneficiario: ex.beneficiario, tipo: ex.tipo });
  } catch (e) {
    console.error("[upload] erro:", e);
    if (!res.headersSent) res.status(500).json({ erro: String(e) });
  }
});

// Preflight CORS pro upload (navegador manda OPTIONS antes do POST).
app.options("/api/upload", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Senha");
  res.sendStatus(204);
});

// Preflight pro relatório
app.options("/api/relatorio", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Senha");
  res.sendStatus(204);
});

// Relatório dos comprovantes selecionados.
// body: { ids: [...], formato: "pdf" | "xlsx", enviarEmail?: "email@..." }
// Se enviarEmail vier, manda por email (PDF+XLSX anexos) e responde JSON.
// Senão, devolve o arquivo pra baixar no formato pedido.
app.post("/api/relatorio", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (!autorizadoDashboard(req)) {
    return res.status(401).json({ erro: "não autorizado" });
  }
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const formato: string = (req.body?.formato || "pdf").toLowerCase();
    const emailDestino: string | undefined = req.body?.enviarEmail;

    if (ids.length === 0) return res.status(400).json({ erro: "nenhum comprovante selecionado" });

    const rows = await comprovantesPorIds(ids);
    const itens: ItemRelatorio[] = rows.map((r) => ({
      data: r.data,
      valor: r.valor,
      beneficiario: r.beneficiario,
      remetente: r.remetente,
    }));

    // Caminho 1: enviar por email (com os dois formatos anexados)
    if (emailDestino) {
      const pdf = await gerarPDF(itens);
      const xlsx = await gerarXLSX(itens);
      await enviarEmailComAnexos(
        emailDestino,
        "Relatório de comprovantes",
        `Segue em anexo o relatório com ${itens.length} comprovante(s).`,
        [
          { filename: "relatorio.pdf", content: pdf },
          { filename: "relatorio.xlsx", content: xlsx },
        ],
      );
      return res.json({ ok: true, enviadoPara: emailDestino });
    }

    // Caminho 2: baixar o arquivo no formato pedido
    if (formato === "xlsx" || formato === "xls") {
      const buf = await gerarXLSX(itens);
      res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.set("Content-Disposition", 'attachment; filename="relatorio.xlsx"');
      return res.send(buf);
    } else {
      const buf = await gerarPDF(itens);
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", 'attachment; filename="relatorio.pdf"');
      return res.send(buf);
    }
  } catch (e) {
    console.error("[relatorio] erro:", e);
    if (!res.headersSent) res.status(500).json({ erro: String(e) });
  }
});

// Exclusão manual de um comprovante/solicitação (ex: enviado no grupo errado).
// Exige a mesma senha do dashboard, reenviada no momento da exclusão (não fica
// gravada em botão nenhum) — evita apagar por clique errado.
app.options("/api/comprovantes/:id", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Senha");
  res.sendStatus(204);
});

app.delete("/api/comprovantes/:id", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (!autorizadoDashboard(req)) {
    return res.status(401).json({ erro: "não autorizado" });
  }
  try {
    const id = req.params.id;
    const r = await excluirComprovante(id);
    if (!r.ok) return res.status(404).json({ erro: "comprovante não encontrado" });
    // A planilha NÃO é alterada aqui de propósito — fica como registro histórico
    // de tudo que já passou pelo sistema, mesmo o que depois foi excluído do dashboard.
    console.log(`[excluido] ${id} removido do dashboard (mantido na planilha como histórico)`);
    res.json({ ok: true });
  } catch (e) {
    console.error("[excluir] erro:", e);
    if (!res.headersSent) res.status(500).json({ erro: String(e) });
  }
});

app.get("/health", (_req, res) => res.send("ok"));

// Preview do relatório sem enviar (teste manual no navegador).
app.get("/relatorio/preview", async (req, res) => {
  try {
    const data = (req.query.data as string) || dataSP();
    const { texto } = await gerarRelatorio(data);
    res.type("text/plain").send(texto);
  } catch (e) {
    console.error("[relatorio/preview] erro:", e);
    res.status(500).send(String(e));
  }
});

// ================================================================
// MÓDULO NF/BOLETOS (contas a receber) — endpoints do dashboard novo
// (public/nf-boletos.html). Reaproveita a mesma senha do dashboard atual.
// ================================================================

function corsVendas(res: express.Response, metodos: string) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", `${metodos}, OPTIONS`);
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Senha");
}

app.options("/api/vendas/*", (_req, res) => {
  corsVendas(res, "GET, POST, OPTIONS");
  res.sendStatus(204);
});

app.get("/api/vendas/nfs", async (req, res) => {
  corsVendas(res, "GET");
  if (!autorizadoDashboard(req)) return res.status(401).json({ erro: "não autorizado" });
  try {
    const status = (req.query.status as string) || undefined;
    const nfs = await listarNfsVenda(status === "pendente" || status === "dividida" ? status : undefined);
    res.json({ nfs });
  } catch (e) {
    console.error("[vendas/nfs] erro:", e);
    res.status(500).json({ erro: String(e) });
  }
});

// Upload manual do XML da NF de venda (equivalente ao /api/upload dos comprovantes).
app.post("/api/vendas/upload", async (req, res) => {
  corsVendas(res, "POST");
  if (!autorizadoDashboard(req)) return res.status(401).json({ erro: "não autorizado" });
  try {
    const { file, fileName } = req.body || {};
    if (!file || typeof file !== "string") {
      return res.status(400).json({ erro: "campo 'file' é obrigatório" });
    }
    // Aceita texto puro do XML, base64 puro, ou data URL ("data:...;base64,XXX").
    let xmlTexto: string;
    if (file.trim().startsWith("<")) {
      xmlTexto = file;
    } else {
      const base64 = file.includes(",") ? file.split(",")[1] : file;
      xmlTexto = Buffer.from(base64, "base64").toString("utf-8");
    }

    const hash = createHash("sha256").update(xmlTexto).digest("hex").slice(0, 24);
    const identificador = `upload-venda-${hash}`;
    const arquivoUrl = await subirArquivoXmlVenda(xmlTexto, identificador);

    const r = await processarNfVenda(xmlTexto, {
      identificador,
      fileName: fileName ?? null,
      arquivoUrl,
      dataChegada: dataSP(),
    });

    if (r.status === "ignorado") return res.status(200).json({ ok: false, motivo: r.motivo });
    if (r.status === "duplicado") return res.status(200).json({ ok: false, motivo: "Esta NF já foi enviada antes." });
    return res.json({ ok: true, nf: r.nf });
  } catch (e) {
    console.error("[vendas/upload] erro:", e);
    if (!res.headersSent) res.status(500).json({ erro: String(e) });
  }
});

// Só interpreta o texto livre da divisão (prévia) — não grava nada ainda.
app.post("/api/vendas/parse-divisao", async (req, res) => {
  corsVendas(res, "POST");
  if (!autorizadoDashboard(req)) return res.status(401).json({ erro: "não autorizado" });
  try {
    const texto: string = String(req.body?.texto || "");
    const parsed = parseDivisao(texto);
    res.json(parsed);
  } catch (e) {
    console.error("[vendas/parse-divisao] erro:", e);
    res.status(500).json({ erro: String(e) });
  }
});

// Confirma a divisão (já revisada pela pessoa) e grava os boletos + relatório.
// body: { itens: [{ banco: string|null, valor: number }, ...] }
app.post("/api/vendas/nfs/:id/dividir", async (req, res) => {
  corsVendas(res, "POST");
  if (!autorizadoDashboard(req)) return res.status(401).json({ erro: "não autorizado" });
  try {
    const nfId = Number(req.params.id);
    const itens: { banco: string | null; valor: number }[] = Array.isArray(req.body?.itens) ? req.body.itens : [];
    if (!nfId || itens.length === 0) return res.status(400).json({ erro: "nf inválida ou nenhum item pra dividir" });

    const nf = await buscarNfVendaPorId(nfId);
    if (!nf) return res.status(404).json({ erro: "NF não encontrada" });
    if (nf.status === "dividida") return res.status(409).json({ erro: "esta NF já foi dividida antes" });

    const itensValidos = itens
      .map((it) => ({ banco: it.banco || null, valor: Number(it.valor) }))
      .filter((it) => Number.isFinite(it.valor) && it.valor > 0);
    if (itensValidos.length === 0) return res.status(400).json({ erro: "nenhum valor válido informado" });

    const { boletos, relatorioId } = await dividirNfEmBoletos(nfId, nf.numero_nf, itensValidos);
    res.json({ ok: true, boletos, relatorioId });
  } catch (e) {
    console.error("[vendas/dividir] erro:", e);
    if (!res.headersSent) res.status(500).json({ erro: String(e) });
  }
});

app.get("/api/vendas/boletos", async (req, res) => {
  corsVendas(res, "GET");
  if (!autorizadoDashboard(req)) return res.status(401).json({ erro: "não autorizado" });
  try {
    const status = (req.query.status as string) || undefined;
    const boletos = await listarBoletosVenda(
      status === "aberto" || status === "pago" || status === "nao_conciliado" ? status : undefined,
    );
    res.json({ boletos });
  } catch (e) {
    console.error("[vendas/boletos] erro:", e);
    res.status(500).json({ erro: String(e) });
  }
});

// Relatório de solicitação (PDF/XLSX) de uma divisão específica.
app.get("/api/vendas/relatorio/:relatorioId", async (req, res) => {
  corsVendas(res, "GET");
  if (!autorizadoDashboard(req)) return res.status(401).json({ erro: "não autorizado" });
  try {
    const relatorioId = Number(req.params.relatorioId);
    const formato = ((req.query.formato as string) || "pdf").toLowerCase();

    const relatorio = await buscarRelatorioPorId(relatorioId);
    if (!relatorio) return res.status(404).json({ erro: "relatório não encontrado" });
    const nf = await buscarNfVendaPorId(relatorio.nf_id);
    if (!nf) return res.status(404).json({ erro: "NF do relatório não encontrada" });
    const boletos = await listarBoletosPorNf(relatorio.nf_id);

    const itens: ItemRelatorioBoleto[] = boletos.map((b) => ({
      data: nf.data,
      numeroNf: nf.numero_nf,
      cnpj: nf.cnpj,
      cliente: nf.cliente,
      seuNumero: b.seu_numero,
      banco: b.banco,
      valor: b.valor,
    }));

    if (formato === "xlsx" || formato === "xls") {
      const buf = await gerarXLSXBoletos(relatorioId, itens);
      res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.set("Content-Disposition", `attachment; filename="solicitacao-${relatorioId}.xlsx"`);
      return res.send(buf);
    } else {
      const buf = await gerarPDFBoletos(relatorioId, itens);
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `attachment; filename="solicitacao-${relatorioId}.pdf"`);
      return res.send(buf);
    }
  } catch (e) {
    console.error("[vendas/relatorio] erro:", e);
    if (!res.headersSent) res.status(500).json({ erro: String(e) });
  }
});

// Upload da folha de liquidações (CSV) e conciliação automática.
// body: { conteudo: string } — texto puro do CSV.
app.post("/api/vendas/csv", async (req, res) => {
  corsVendas(res, "POST");
  if (!autorizadoDashboard(req)) return res.status(401).json({ erro: "não autorizado" });
  try {
    const conteudo: string = String(req.body?.conteudo || "");
    if (!conteudo.trim()) return res.status(400).json({ erro: "campo 'conteudo' (texto do CSV) é obrigatório" });
    const resultado = await conciliarLiquidacao(conteudo);
    res.json({ ok: true, ...resultado });
  } catch (e) {
    console.error("[vendas/csv] erro:", e);
    if (!res.headersSent) res.status(500).json({ erro: String(e) });
  }
});

app.get("/api/vendas/conciliacoes-pendentes", async (req, res) => {
  corsVendas(res, "GET");
  if (!autorizadoDashboard(req)) return res.status(401).json({ erro: "não autorizado" });
  try {
    const pendentes = await listarConciliacoesPendentes();
    res.json({ pendentes });
  } catch (e) {
    console.error("[vendas/conciliacoes-pendentes] erro:", e);
    res.status(500).json({ erro: String(e) });
  }
});

// Resolve manualmente uma linha do CSV que não bateu automaticamente, vinculando a um boleto.
// body: { boletoId: number }
app.post("/api/vendas/conciliacoes-pendentes/:id/resolver", async (req, res) => {
  corsVendas(res, "POST");
  if (!autorizadoDashboard(req)) return res.status(401).json({ erro: "não autorizado" });
  try {
    const id = Number(req.params.id);
    const boletoId = Number(req.body?.boletoId);
    if (!id || !boletoId) return res.status(400).json({ erro: "id e boletoId são obrigatórios" });
    await resolverConciliacaoPendente(id, boletoId, dataSP());
    res.json({ ok: true });
  } catch (e) {
    console.error("[vendas/conciliacoes-pendentes/resolver] erro:", e);
    if (!res.headersSent) res.status(500).json({ erro: String(e) });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`ouvindo na porta ${port}`));
