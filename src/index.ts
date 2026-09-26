import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabase } from './supabase.js';
import { processImport } from './process-tournament.js';
import { notifyTournamentSummary } from './notify.js';

interface ImportRow {
  id: string;
  tournament_id: string;
  base_url: string;
  pairing_group_name: string | null;
  enabled: boolean;
  tournaments: {
    status: string;
    start_date: string | null;
    end_date: string | null;
  };
}

// O Scheduler dispara a cada 1-2 minutos, mas uma execução real pode levar
// vários minutos — sem trava, várias execuções rodavam ao mesmo tempo escrevendo na
// mesma tournament_players (migration 072). Trava expira sozinha depois desse
// tanto de minutos caso o processo anterior tenha morrido sem liberar.
const LOCK_STALE_MINUTES = 10;
const LOCK_HEARTBEAT_MS = 60_000;
const IMPORT_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number.parseInt(process.env.IMPORT_CONCURRENCY ?? '3', 10) || 3),
);

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

async function refreshLock(supabase: SupabaseClient): Promise<void> {
  try {
    const { error } = await supabase
      .from('cron_import_lock')
      .update({ locked_at: new Date().toISOString() })
      .eq('id', 1);
    if (error) console.error('Falha ao renovar trava:', error.message);
  } catch (error) {
    console.error('Falha ao renovar trava:', error instanceof Error ? error.message : error);
  }
}

function sortImports(rows: ImportRow[]): ImportRow[] {
  const statusPriority = (status: string) => status === 'ongoing' ? 0 : 1;

  return [...rows].sort((a, b) => {
    const byStatus = statusPriority(a.tournaments.status) - statusPriority(b.tournaments.status);
    if (byStatus !== 0) return byStatus;

    // Entre torneios com o mesmo status, o mais recente vem primeiro. Assim
    // um evento atual nunca espera um import antigo ainda marcado como ativo.
    const aDate = a.tournaments.start_date ?? a.tournaments.end_date ?? '';
    const bDate = b.tournaments.start_date ?? b.tournaments.end_date ?? '';
    const byDate = bDate.localeCompare(aDate);
    if (byDate !== 0) return byDate;

    const byTournament = a.tournament_id.localeCompare(b.tournament_id);
    if (byTournament !== 0) return byTournament;

    return (a.pairing_group_name ?? '').localeCompare(
      b.pairing_group_name ?? '',
      'pt-BR',
      { numeric: true },
    );
  });
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      await worker(item);
    }
  }));
}

async function main() {
  const supabase = createSupabase();

  if (!(await acquireLock(supabase))) {
    console.log('Outra execução já está em andamento — pulando esta chamada.');
    process.exit(0);
  }

  // O ciclo pode durar vários minutos em torneios com muitas categorias.
  // Renovar a trava evita que o scheduler de 2 minutos abra outro ciclo em
  // paralelo quando o trabalho legítimo ultrapassa LOCK_STALE_MINUTES.
  const heartbeat = setInterval(() => void refreshLock(supabase), LOCK_HEARTBEAT_MS);
  heartbeat.unref();

  try {
    // Torneio finished/cancelled não muda mais no chess-results — não vale
    // continuar gastando execução com ele. draft/published/registration/
    // registration_closed/ongoing continuam entrando: é justamente antes de
    // 'ongoing' que o organizador edita a lista de participantes.
    const { data, error } = await supabase
      .from('tournament_imports')
      .select('id, tournament_id, base_url, pairing_group_name, enabled, tournaments!inner(status, start_date, end_date)')
      .eq('enabled', true)
      .not('tournaments.status', 'in', '(finished,cancelled)');

    if (error) {
      console.error('Falha ao listar imports:', error.message);
      process.exit(1);
    }

    const rows = sortImports((data ?? []) as unknown as ImportRow[]);
    console.log(`Processando ${rows.length} importação(ões) habilitada(s), concorrência ${IMPORT_CONCURRENCY}`);

    let okCount = 0;
    let errCount = 0;

    await runWithConcurrency(rows, IMPORT_CONCURRENCY, async (row) => {
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
      } finally {
        await refreshLock(supabase);
      }
    });

    // O resumo para quem não segue jogadores só pode ser avaliado depois que
    // todas as categorias do torneio terminaram este ciclo de sincronização.
    for (const tournamentId of new Set(rows.map((row) => row.tournament_id))) {
      await notifyTournamentSummary(tournamentId);
    }

    console.log(`Concluído. ${okCount} ok, ${errCount} com erro.`);
  } finally {
    clearInterval(heartbeat);
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
