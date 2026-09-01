-- Tabela de comprovantes. message_id é UNIQUE = dedupe garantido no banco.
-- Guarda os dois tipos de documento identificados no grupo do WhatsApp:
--   status = 'pago'       -> comprovante de pagamento já efetuado
--   status = 'solicitado' -> boleto/cobrança em aberto (uma solicitação de pagamento)
-- Nota: este arquivo estava incompleto em relação ao banco em produção
-- (faltavam beneficiario/remetente/arquivo_url/fingerprint). Corrigido
-- aqui para refletir todas as colunas que o código realmente usa.
create table if not exists comprovantes (
  id            bigint generated always as identity primary key,
  message_id    text not null unique,
  valor         numeric(12,2),
  data          date not null,
  status        text not null default 'pago' check (status in ('pago', 'solicitado')),
  vencimento    date,           -- só preenchido quando status = 'solicitado'
  beneficiario  text,
  remetente     text,
  fingerprint   text,
  arquivo_url   text,
  file_name     text,
  mime_type     text,
  raw_valor     text,           -- o que o modelo devolveu, pra auditoria
  created_at    timestamptz not null default now()
);

-- Consulta do relatório diário fica rápida.
create index if not exists idx_comprovantes_data on comprovantes (data);
create index if not exists idx_comprovantes_status on comprovantes (status);

-- ================================================================
-- MIGRAÇÃO: rode isto se a tabela "comprovantes" já existir no seu
-- banco (Supabase) SEM as colunas status/vencimento. Se está criando
-- o banco do zero, o create table acima já cria tudo — pode ignorar.
-- ================================================================
-- alter table comprovantes add column if not exists status text not null default 'pago';
-- alter table comprovantes add column if not exists vencimento date;
-- alter table comprovantes add constraint comprovantes_status_check check (status in ('pago', 'solicitado'));
-- create index if not exists idx_comprovantes_status on comprovantes (status);
