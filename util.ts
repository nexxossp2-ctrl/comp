/** YYYY-MM-DD no fuso America/Sao_Paulo (evita comprovante da noite cair no dia seguinte). */
export function dataSP(ms: number = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** YYYY-MM-DD -> DD/MM/YYYY */
export function dataBR(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** número -> R$ 1.234,56 */
export function brl(n: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);
}
