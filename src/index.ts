import { createSupabase } from './supabase.js';
import { processImport } from './process-tournament.js';

interface ImportRow {
  id: string;
  tournament_id: string;
  base_url: string;
  pairing_group_name: string | null;
  enabled: boolean;
}

async function main() {
  const supabase = createSupabase();

  const { data, error } = await supabase
    .from('tournament_imports')
    .select('id, tournament_id, base_url, pairing_group_name, enabled')
    .eq('enabled', true);

  if (error) {
    console.error('Falha ao listar imports:', error.message);
    process.exit(1);
  }

  const rows = (data ?? []) as ImportRow[];
  console.log(`Processando ${rows.length} importação(ões) habilitada(s)`);

  let okCount = 0;
  let errCount = 0;

  for (const row of rows) {
    const label = `[${row.id}] ${row.tournament_id}${row.pairing_group_name ? ` / ${row.pairing_group_name}` : ''}`;
    console.log(`${label} iniciando...`);
    const startedAt = new Date().toISOString();
    try {
      const summary = await processImport(supabase, row);
      await supabase
        .from('tournament_imports')
        .update({
          last_run_at: startedAt,
          last_status: 'success',
          last_message: summary.slice(0, 500),
        })
        .eq('id', row.id);
      console.log(`${label} ok — ${summary}`);
      okCount++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase
        .from('tournament_imports')
        .update({
          last_run_at: startedAt,
          last_status: 'error',
          last_message: message.slice(0, 500),
        })
        .eq('id', row.id);
      console.error(`${label} ERRO — ${message}`);
      errCount++;
    }
  }

  console.log(`Concluído. ${okCount} ok, ${errCount} com erro.`);
  // Cloud Run Jobs only mark a run as failed if the process exits non-zero.
  // We exit 0 even on partial errors so successful imports aren't retried needlessly;
  // failures are tracked per-row in tournament_imports.last_status.
  process.exit(0);
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
