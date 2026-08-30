-- Tabela de comprovantes. message_id é UNIQUE = dedupe garantido no banco.
create table if not exists comprovantes (
  id           bigint generated always as identity primary key,
  message_id   text not null unique,
  valor        numeric(12,2),
  data         date not null,
  file_name    text,
  mime_type    text,
  raw_valor    text,           -- o que o modelo devolveu, pra auditoria
  created_at   timestamptz not null default now()
);

-- Consulta do relatório diário fica rápida.
create index if not exists idx_comprovantes_data on comprovantes (data);
