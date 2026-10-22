// Avisa o chess-viewer que uma rodada foi publicada, para ele disparar o push
// (segmentação por seguidores + deduplicação de eventos). O push vive só no app —
// aqui apenas notificamos por HTTP (opção 1: fonte única do push no app).
//
// Requer CHESS_VIEWER_URL (origem do app) e CRON_PUSH_SECRET (mesmo segredo
// configurado no app). Sem essas variáveis, o passo é pulado com aviso — a
// importação em si não falha por causa disso.

async function notifyImportEvents(payload: { roundId: string } | { tournamentId: string }): Promise<void> {
  const base = process.env.CHESS_VIEWER_URL;
  const secret = process.env.CRON_PUSH_SECRET;
  if (!base || !secret) {
    console.warn('[notify] CHESS_VIEWER_URL/CRON_PUSH_SECRET ausente — push da rodada pulado');
    return;
  }

  const url = `${base.replace(/\/$/, '')}/api/internal/notify-round`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[notify] eventos falharam (${res.status}):`, JSON.stringify(body));
    } else {
      console.log('[notify] eventos:', JSON.stringify(body));
    }
  } catch (e) {
    console.error('[notify] erro de rede:', (e as Error).message);
  }
}

export async function notifyRoundPublished(roundId: string): Promise<void> {
  await notifyImportEvents({ roundId });
}

export async function notifyTournamentSummary(tournamentId: string): Promise<void> {
  await notifyImportEvents({ tournamentId });
}

/**
 * Avisa o dev (push no app) que a sincronização de um torneio quebrou ou voltou a funcionar.
 * Chamado só na MUDANÇA de estado (ou quando o motivo do erro muda) — ver index.ts — pra não
 * mandar um push a cada execução de 2 minutos.
 */
export async function notifyImportStatus(payload: {
  tournamentId: string;
  groupName: string | null;
  status: 'error' | 'recovered';
  message?: string;
}): Promise<void> {
  const base = process.env.CHESS_VIEWER_URL;
  const secret = process.env.CRON_PUSH_SECRET;
  if (!base || !secret) {
    console.warn('[notify] CHESS_VIEWER_URL/CRON_PUSH_SECRET ausente — aviso de status pulado');
    return;
  }
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/internal/import-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error(`[notify] aviso de status falhou (${res.status})`);
  } catch (e) {
    console.error('[notify] aviso de status — erro de rede:', (e as Error).message);
  }
}

/**
 * Dispara a rodada diária dos alertas de torneio no app (espelho do calendário da
 * CBX + avisos por regra). A rota se auto-limita a uma execução por dia, então
 * chamar a cada ciclo de 2 minutos é barato: quase sempre volta "skipped".
 */
export async function triggerTournamentAlerts(): Promise<void> {
  const base = process.env.CHESS_VIEWER_URL;
  const secret = process.env.CRON_PUSH_SECRET;
  if (!base || !secret) return;
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/internal/tournament-alerts`, {
      method: 'POST',
      headers: { 'x-cron-secret': secret },
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await res.json().catch(() => ({}))) as { skipped?: string };
    if (!res.ok) console.error(`[alerts] falhou (${res.status}):`, JSON.stringify(body));
    else if (!body.skipped) console.log('[alerts]', JSON.stringify(body));
  } catch (e) {
    console.error('[alerts] erro de rede:', (e as Error).message);
  }
}
