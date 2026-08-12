// Avisa o chess-viewer que uma rodada foi publicada, para ele disparar o push
// (sendTournamentNotification + notifyPlayerFollowers). O push vive só no app —
// aqui apenas notificamos por HTTP (opção 1: fonte única do push no app).
//
// Requer CHESS_VIEWER_URL (origem do app) e CRON_PUSH_SECRET (mesmo segredo
// configurado no app). Sem essas variáveis, o passo é pulado com aviso — a
// importação em si não falha por causa disso.

export async function notifyRoundPublished(roundId: string): Promise<void> {
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
      body: JSON.stringify({ roundId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[notify] rodada ${roundId} falhou (${res.status}):`, JSON.stringify(body));
    } else {
      console.log(`[notify] rodada ${roundId}:`, JSON.stringify(body));
    }
  } catch (e) {
    console.error(`[notify] rodada ${roundId} erro de rede:`, (e as Error).message);
  }
}
