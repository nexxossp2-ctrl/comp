import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import { brl, dataBR } from "./util.js";

export interface ItemRelatorioBoleto {
  data: string; // data de emissão da NF
  numeroNf: string;
  cnpj: string | null;
  cliente: string | null;
  seuNumero: string;
  banco: string | null;
  valor: number;
}

/** Gera o PDF do relatório de solicitação de boletos (um por divisão feita). */
export function gerarPDFBoletos(relatorioId: number, itens: ItemRelatorioBoleto[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const total = itens.reduce((s, i) => s + (Number(i.valor) || 0), 0);

    doc.fontSize(18).text(`Relatório de solicitação #${relatorioId}`, { align: "left" });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#666").text(`Gerado em ${dataBR(new Date().toISOString().slice(0, 10))}`);
    doc.moveDown(1);

    const y0 = doc.y;
    doc.fillColor("#000").fontSize(9);
    doc.text("Data", 40, y0, { width: 55 });
    doc.text("NF", 95, y0, { width: 45 });
    doc.text("CNPJ", 140, y0, { width: 100 });
    doc.text("Nome", 240, y0, { width: 175 });
    doc.text("Seu número", 415, y0, { width: 65 });
    doc.text("Valor", 480, y0, { width: 75, align: "right" });
    doc.moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).stroke("#ccc");
    doc.moveDown(0.5);

    for (const i of itens) {
      const y = doc.y;
      doc.fillColor("#000").fontSize(9);
      const nome = i.cliente || "-";
      const hLinha = Math.max(doc.heightOfString(nome, { width: 175 }), 12);
      if (y + hLinha > 790) doc.addPage();
      const yy = doc.y;

      doc.text(dataBR(i.data), 40, yy, { width: 55 });
      doc.text(i.numeroNf, 95, yy, { width: 45 });
      doc.text(i.cnpj || "-", 140, yy, { width: 100 });
      doc.text(nome, 240, yy, { width: 175 });
      doc.text(i.seuNumero, 415, yy, { width: 65 });
      doc.text(brl(Number(i.valor)), 480, yy, { width: 75, align: "right" });

      doc.y = yy + hLinha + 4;
    }

    doc.moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).stroke("#ccc");
    doc.moveDown(0.5);
    doc.fontSize(12).fillColor("#000").text(
      `Total: ${brl(total)}  (${itens.length} boleto${itens.length === 1 ? "" : "s"})`,
      40,
      doc.y,
      { align: "right", width: 515 },
    );

    doc.end();
  });
}

/** Gera o XLSX do relatório de solicitação de boletos. */
export async function gerarXLSXBoletos(relatorioId: number, itens: ItemRelatorioBoleto[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`Solicitação #${relatorioId}`);

  ws.columns = [
    { header: "Data", key: "data", width: 14 },
    { header: "Número NF", key: "numeroNf", width: 14 },
    { header: "CNPJ", key: "cnpj", width: 20 },
    { header: "Nome", key: "cliente", width: 40 },
    { header: "Seu número", key: "seuNumero", width: 16 },
    { header: "Banco", key: "banco", width: 18 },
    { header: "Valor", key: "valor", width: 16 },
  ];
  ws.getRow(1).font = { bold: true };

  for (const i of itens) {
    ws.addRow({
      data: dataBR(i.data),
      numeroNf: i.numeroNf,
      cnpj: i.cnpj || "",
      cliente: i.cliente || "",
      seuNumero: i.seuNumero,
      banco: i.banco || "",
      valor: Number(i.valor),
    });
  }
  ws.getColumn("valor").numFmt = "R$ #,##0.00";

  const total = itens.reduce((s, i) => s + (Number(i.valor) || 0), 0);
  const totalRow = ws.addRow({ cliente: "Total", valor: total });
  totalRow.font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
