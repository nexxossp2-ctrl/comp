import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import { brl, dataBR } from "./util.js";

export interface ItemRelatorio {
  data: string;
  valor: number | null;
  beneficiario: string | null;
  remetente: string | null;
}

/** Gera um PDF do relatório em memória e devolve como Buffer. */
export function gerarPDF(itens: ItemRelatorio[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const total = itens.reduce((s, i) => s + (Number(i.valor) || 0), 0);

    doc.fontSize(18).text("Relatório de Comprovantes", { align: "left" });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#666").text(`Gerado em ${dataBR(new Date().toISOString().slice(0, 10))}`);
    doc.moveDown(1);

    // Cabeçalho da tabela
    const y0 = doc.y;
    doc.fillColor("#000").fontSize(10);
    doc.text("Data", 40, y0, { width: 80 });
    doc.text("Beneficiário", 120, y0, { width: 220 });
    doc.text("Quem enviou", 340, y0, { width: 120 });
    doc.text("Valor", 460, y0, { width: 90, align: "right" });
    doc.moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).stroke("#ccc");
    doc.moveDown(0.5);

    for (const i of itens) {
      const y = doc.y;
      doc.fillColor("#000").fontSize(9);

      const benef = i.beneficiario || "-";
      const remet = i.remetente || "-";

      // Mede a altura que cada coluna de texto vai ocupar (nomes longos quebram linha).
      const hBenef = doc.heightOfString(benef, { width: 220 });
      const hRemet = doc.heightOfString(remet, { width: 120 });
      const hLinha = Math.max(hBenef, hRemet, 12);

      // Quebra de página se não couber
      if (y + hLinha > 790) {
        doc.addPage();
      }
      const yy = doc.y;

      doc.text(dataBR(i.data), 40, yy, { width: 80 });
      doc.text(benef, 120, yy, { width: 220 });
      doc.text(remet, 340, yy, { width: 120 });
      doc.text(i.valor != null ? brl(Number(i.valor)) : "-", 460, yy, { width: 90, align: "right" });

      // Avança o cursor pela altura real da linha + respiro
      doc.y = yy + hLinha + 4;
    }

    doc.moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).stroke("#ccc");
    doc.moveDown(0.5);
    doc.fontSize(12).fillColor("#000").text(
      `Total: ${brl(total)}  (${itens.length} comprovante${itens.length === 1 ? "" : "s"})`,
      40,
      doc.y,
      { align: "right", width: 515 },
    );

    doc.end();
  });
}

/** Gera um XLSX do relatório em memória e devolve como Buffer. */
export async function gerarXLSX(itens: ItemRelatorio[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Comprovantes");

  ws.columns = [
    { header: "Data", key: "data", width: 14 },
    { header: "Beneficiário", key: "beneficiario", width: 36 },
    { header: "Quem enviou", key: "remetente", width: 24 },
    { header: "Valor", key: "valor", width: 16 },
  ];
  ws.getRow(1).font = { bold: true };

  for (const i of itens) {
    ws.addRow({
      data: dataBR(i.data),
      beneficiario: i.beneficiario || "",
      remetente: i.remetente || "",
      valor: i.valor != null ? Number(i.valor) : null,
    });
  }

  // Formata a coluna de valor como moeda BRL
  ws.getColumn("valor").numFmt = 'R$ #,##0.00';

  const total = itens.reduce((s, i) => s + (Number(i.valor) || 0), 0);
  const totalRow = ws.addRow({ remetente: "Total", valor: total });
  totalRow.font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
