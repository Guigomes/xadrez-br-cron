import { createSupabase } from './supabase.js';
import { notifyTournamentSummary, triggerTournamentAlerts } from './notify.js';
import { acquireLock, releaseLock, refreshLock } from './lock.js';
import { runImportRow } from './run-import.js';
import { IDLE_INTERVAL_MINUTES, importHasRounds, shouldSkipIdle, type GroupRef, type RoundRef } from './idle-schedule.js';

interface ImportRow {
  id: string;
  tournament_id: string;
  base_url: string;
  pairing_group_name: string | null;
  /** false: ignora a coluna "Tipo" da fonte (sem categoria). */
  import_source_categories?: boolean;
  enabled: boolean;
  /** Estado da execução anterior — pra avisar o dev só quando muda. */
  last_status: string | null;
  last_message: string | null;
  last_run_at: string | null;
  /** Pedido de sincronização imediata feito pelo botão do admin no site. */
  force_requested_at: string | null;
  tournaments: {
    status: string;
    start_date: string | null;
    end_date: string | null;
  };
}

const LOCK_HEARTBEAT_MS = 60_000;
const IMPORT_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number.parseInt(process.env.IMPORT_CONCURRENCY ?? '3', 10) || 3),
);

function sortImports(rows: ImportRow[]): ImportRow[] {
  const statusPriority = (status: string) => status === 'ongoing' ? 0 : 1;

  return [...rows].sort((a, b) => {
    // Pedido do admin ("forçar sincronização") passa na frente de tudo.
    const byForce = Number(!!b.force_requested_at) - Number(!!a.force_requested_at);
    if (byForce !== 0) return byForce;

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

// Conta requisições ao chess-results por ciclo (log no fim), para acompanhar o volume.
let chessResultsRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (/chess-results\.com/i.test(url)) chessResultsRequests++;
  return originalFetch(input, init);
}) as typeof fetch;

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
    const columns = 'id, tournament_id, base_url, pairing_group_name, import_source_categories, enabled, last_status, last_message, last_run_at, force_requested_at, tournaments!inner(status, start_date, end_date)';
    const [scheduled, forced] = await Promise.all([
      supabase
        .from('tournament_imports')
        .select(columns)
        .eq('enabled', true)
        .not('tournaments.status', 'in', '(finished,cancelled)'),
      // Pedido do admin vale mesmo desligado ou com o torneio encerrado: é
      // justamente o caso de uma importação única de torneio que já aconteceu.
      supabase
        .from('tournament_imports')
        .select(columns)
        .not('force_requested_at', 'is', null),
    ]);

    const error = scheduled.error ?? forced.error;
    if (error) {
      console.error('Falha ao listar imports:', error.message);
      process.exit(1);
    }

    const byId = new Map<string, ImportRow>();
    for (const row of [...((scheduled.data ?? []) as unknown as ImportRow[]), ...((forced.data ?? []) as unknown as ImportRow[])]) {
      byId.set(row.id, row);
    }
    // ONLY_TOURNAMENT_IDS (lista separada por vírgula): roda só esses torneios.
    // Uso: loop local dedicado a um evento ao vivo, sem gastar ciclo com os demais.
    const onlyIds = (process.env.ONLY_TOURNAMENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const candidates = sortImports([...byId.values()].filter((row) => !onlyIds.length || onlyIds.includes(row.tournament_id)));
    if (onlyIds.length) console.log(`Filtro ONLY_TOURNAMENT_IDS: ${onlyIds.join(', ')}`);

    // Sem rodada no banco ainda: só a cada IDLE_INTERVAL_MINUTES (ver idle-schedule.ts).
    const tournamentIds = [...new Set(candidates.map((row) => row.tournament_id))];
    let rounds: RoundRef[] = [];
    let groups: GroupRef[] = [];
    let roundsKnown = true;
    if (tournamentIds.length > 0) {
      const [roundsRes, groupsRes] = await Promise.all([
        supabase.from('rounds').select('tournament_id, pairing_group_id').in('tournament_id', tournamentIds),
        supabase.from('pairing_groups').select('id, tournament_id, name').in('tournament_id', tournamentIds),
      ]);
      if (roundsRes.error || groupsRes.error) {
        // Sem saber se tem rodada, roda tudo como antes.
        console.error('Falha ao ler rodadas (sem espaçar os sem rodada):', (roundsRes.error ?? groupsRes.error)?.message);
        roundsKnown = false;
      } else {
        rounds = (roundsRes.data ?? []) as RoundRef[];
        groups = (groupsRes.data ?? []) as GroupRef[];
      }
    }
    const now = Date.now();
    const rows = candidates.filter((row) =>
      !roundsKnown || !shouldSkipIdle(row, importHasRounds(row, rounds, groups), now),
    );
    const idleSkipped = candidates.length - rows.length;

    const forcedCount = rows.filter((row) => row.force_requested_at).length;
    console.log(`Processando ${rows.length} importação(ões) (${forcedCount} pedida(s) pelo admin), concorrência ${IMPORT_CONCURRENCY}` +
      (idleSkipped > 0 ? ` · ${idleSkipped} sem rodada aguardando ${IDLE_INTERVAL_MINUTES} min` : ''));

    let okCount = 0;
    let errCount = 0;

    await runWithConcurrency(rows, IMPORT_CONCURRENCY, async (row) => {
      const label = `[${row.id}] ${row.tournament_id}${row.pairing_group_name ? ` / ${row.pairing_group_name}` : ''}`;
      console.log(`${label} iniciando...`);
      const startedAt = new Date().toISOString();
      try {
        const result = await runImportRow(supabase, row);
        if (result.ok) {
          console.log(`${label} ok — ${result.summary}`);
          okCount++;
        } else {
          console.error(`${label} ERRO — ${result.error}`);
          errCount++;
        }
      } finally {
        // Atende o pedido do admin — só os feitos ANTES desta execução começar:
        // um clique durante o processamento continua valendo para a próxima.
        if (row.force_requested_at) {
          await supabase
            .from('tournament_imports')
            .update({ force_requested_at: null })
            .eq('id', row.id)
            .lte('force_requested_at', startedAt);
        }
        await refreshLock(supabase);
      }
    });

    // O resumo para quem não segue jogadores só pode ser avaliado depois que
    // todas as categorias do torneio terminaram este ciclo de sincronização.
    for (const tournamentId of new Set(rows.map((row) => row.tournament_id))) {
      await notifyTournamentSummary(tournamentId);
    }

    console.log(`Concluído. ${okCount} ok, ${errCount} com erro. Requisições ao chess-results: ${chessResultsRequests}.`);

    // Alertas de torneio do app: a rota decide se já é hora (uma vez por dia).
    await triggerTournamentAlerts();
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
