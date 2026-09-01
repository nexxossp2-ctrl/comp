import express from "express";
import path from "path";
import cron from "node-cron";
import { createHash } from "crypto";
import archiver from "archiver";
import { extrairBase64, baixarBase64, type Extracao } from "./extract.js";
import { salvarComprovante, listarComprovantes, subirArquivo, linkAssinado, comprovantesPorIds, baixarArquivo, excluirComprovante } from "./supabase.js";
import { gerarPDF, gerarXLSX, type ItemRelatorio } from "./relatorio-arquivo.js";
import { appendLinha } from "./sheets.js";
import { gerarRelatorio } from "./report.js";
import { enviarEmail, enviarWhatsapp, enviarEmailComAnexos } from "./send.js";
import { dataSP, dataBR } from "./util.js";

const app = express();
app.use(express.json({ limit: "25mb" }));
// Serve arquivos estáticos da pasta public/ (ex: /dashboard-geral.html)
app.use(express.static(path.join(process.cwd(), "public")));

const GRUPO_ID = (process.env.GRUPO_ID || "").trim();

type ResultadoProc =
  | { status: "salvo"; tipo: "pago" | "solicitado"; valor: number | null; beneficiario: string | null }
  | { status: "ignorado" }
  | { status: "duplicado" };

/**
 * Processamento único usado pelo WhatsApp e pelo upload:
 * classifica pago/boleto/outro, deduplica e grava no banco (+ planilha, só quando pago).
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

  const inserido = await salvarComprovante({
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
  });

  if (!inserido) {
    console.log(`[dup] ${meta.identificador} já processado, ignorado`);
    return { status: "duplicado" };
  }

  // Planilha continua só com o que já foi pago (mantém o relatório/uso atual sem mudanças).
  if (status === "pago") {
    await appendLinha({
      data: dataFinal,
      valor: ex.valor,
      identificador: meta.identificador,
      remetente: meta.remetente,
      beneficiario: ex.beneficiario,
    });
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

    const rows = await comprovantesPorIds(ids);
    const comArquivo = rows.filter((r) => r.arquivo_url);
    if (comArquivo.length === 0) {
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

    const usados = new Set<string>();
    for (const r of comArquivo) {
      const buf = await baixarArquivo(r.arquivo_url as string);
      if (!buf) continue;
      const ext = (r.arquivo_url as string).split(".").pop() || "jpg";
      // Nome amigável: data_beneficiario. Evita colisão com sufixo.
      const base = `${r.data}_${(r.beneficiario || "comprovante").replace(/[^\w\-]+/g, "-")}`;
      let nome = `${base}.${ext}`;
      let i = 2;
      while (usados.has(nome)) nome = `${base}-${i++}.${ext}`;
      usados.add(nome);
      zip.append(buf, { name: nome });
    }

    await zip.finalize();
  } catch (e) {
    console.error("[download] erro:", e);
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
      })),
    );

    const total = comprovantes.reduce((s, c) => s + (Number(c.valor) || 0), 0);

    // Soma agrupada por beneficiário
    const mapa = new Map<string, { total: number; quantidade: number }>();
    for (const c of comprovantes) {
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
    return res.json({ ok: true, valor: ex.valor, beneficiario: ex.beneficiario });
  } catch (e) {
    res.status(500).json({ erro: String(e) });
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
    res.status(500).send(String(e));
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`ouvindo na porta ${port}`));
