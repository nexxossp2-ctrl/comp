import { google } from "googleapis";

const auth = new google.auth.JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID!;
const BACKUP_ID = process.env.SHEETS_BACKUP_ID || ""; // cópia de segurança (opcional)
const TAB = process.env.SHEETS_TAB || "Comprovantes";

/** Escreve uma linha numa planilha específica. */
async function append(spreadsheetId: string, valores: (string | number)[]): Promise<void> {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${TAB}!A:E`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [valores] },
  });
}

/**
 * Uma linha por comprovante, gravada na planilha principal e, se configurada,
 * também na cópia de segurança.
 * Colunas: Data | Valor | Identificador | Quem enviou | Beneficiário
 */
export async function appendLinha(params: {
  data: string;
  valor: number | null;
  identificador: string;
  remetente: string;
  beneficiario: string | null;
}): Promise<void> {
  const linha = [
    params.data,
    params.valor ?? "",
    params.identificador,
    params.remetente,
    params.beneficiario ?? "",
  ];

  await append(SPREADSHEET_ID, linha);

  if (BACKUP_ID) {
    // A cópia não pode derrubar o fluxo principal: se falhar, só loga.
    try {
      await append(BACKUP_ID, linha);
    } catch (e) {
      console.error("[backup sheet] falhou:", e);
    }
  }
}
