import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabase } from './supabase.js';
import { processImport } from './process-tournament.js';

interface ImportRow {
  id: string;
  tournament_id: string;
  base_url: string;
  pairing_group_name: string | null;
  enabled: boolean;
}

// O Scheduler dispara a cada 1-2 minutos, mas uma execução real leva ~5
// minutos — sem trava, várias execuções rodavam ao mesmo tempo escrevendo na
// mesma tournament_players (migration 072). Trava expira sozinha depois desse
// tanto de minutos caso o processo anterior tenha morrido sem liberar.
const LOCK_STALE_MINUTES = 10;

/** true = trava conseguida, esta execução pode prosseguir. */
async function acquireLock(supabase: SupabaseClient): Promise<boolean> {
  const staleThreshold = new Date(Date.now() - LOCK_STALE_MINUTES * 60_000).toISOString();
  const { data, error } = await supabase
    .from('cron_import_lock')
    .update({ locked_at: new Date().toISOString() })
    .eq('id', 1)
    .or(`locked_at.is.null,locked_at.lt.${staleThreshold}`)
    .select('id');
  if (error) {
    console.error('Falha ao tentar travar (seguindo sem trava):', error.message);
    return true; // não bloqueia a importação por causa de erro na trava em si
  }
  return (data?.length ?? 0) > 0;
}

async function releaseLock(supabase: SupabaseClient): Promise<void> {
  await supabase.from('cron_import_lock').update({ locked_at: null }).eq('id', 1);
}

async function main() {
  const supabase = createSupabase();

  if (!(await acquireLock(supabase))) {
    console.log('Outra execução já está em andamento — pulando esta chamada.');
    process.exit(0);
  }

  try {
    // Torneio finished/cancelled não muda mais no chess-results — não vale
    // continuar gastando execução com ele. draft/published/registration/
    // registration_closed/ongoing continuam entrando: é justamente antes de
    // 'ongoing' que o organizador edita a lista de participantes.
    const { data, error } = await supabase
      .from('tournament_imports')
      .select('id, tournament_id, base_url, pairing_group_name, enabled, tournaments!inner(status)')
      .eq('enabled', true)
      .not('tournaments.status', 'in', '(finished,cancelled)');

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
  } finally {
    await releaseLock(supabase);
  }

  // Cloud Run Jobs only mark a run as failed if the process exits non-zero.
  // We exit 0 even on partial errors so successful imports aren't retried needlessly;
  // failures are tracked per-row in tournament_imports.last_status.
  process.exit(0);
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
