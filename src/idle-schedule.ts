/**
 * Importação cujo torneio (ou grupo) ainda não tem nenhuma rodada no banco só
 * é sincronizada a cada IDLE_INTERVAL_MINUTES (padrão 15). Antes da 1ª rodada
 * o que muda na fonte é só a lista de jogadores, e cada sincronização gasta
 * requisições do limite diário por IP do chess-results. Com a 1ª rodada
 * importada, volta ao ritmo de todo ciclo (5 min).
 */
export const IDLE_INTERVAL_MINUTES = Math.max(
  1,
  Number.parseInt(process.env.IDLE_INTERVAL_MINUTES ?? '15', 10) || 15,
);

/**
 * Folga para a variação de horário dentro do ciclo: a linha grava o início do
 * próprio processamento, que pode cair alguns segundos mais tarde num ciclo
 * do que no seguinte. Sem a folga, 15 min viravam 20.
 */
const TOLERANCE_MS = 60_000;

export interface IdleCheckRow {
  force_requested_at: string | null;
  last_run_at: string | null;
}

/** true = pular esta importação neste ciclo. */
export function shouldSkipIdle(
  row: IdleCheckRow,
  hasRounds: boolean,
  now: number = Date.now(),
  idleMinutes: number = IDLE_INTERVAL_MINUTES,
): boolean {
  if (row.force_requested_at) return false; // pedido do admin sempre roda
  if (hasRounds) return false;
  if (!row.last_run_at) return false; // nunca rodou
  const last = Date.parse(row.last_run_at);
  if (Number.isNaN(last)) return false;
  return now - last < idleMinutes * 60_000 - TOLERANCE_MS;
}

export interface RoundRef {
  tournament_id: string;
  pairing_group_id: string | null;
}

export interface GroupRef {
  id: string;
  tournament_id: string;
  name: string;
}

/**
 * Importação sem grupo conta qualquer rodada do torneio; com grupo, só as
 * rodadas do grupo de mesmo nome.
 */
export function importHasRounds(
  row: { tournament_id: string; pairing_group_name: string | null },
  rounds: RoundRef[],
  groups: GroupRef[],
): boolean {
  if (!row.pairing_group_name) {
    return rounds.some((r) => r.tournament_id === row.tournament_id);
  }
  const group = groups.find(
    (g) => g.tournament_id === row.tournament_id && g.name === row.pairing_group_name,
  );
  if (!group) return false;
  return rounds.some((r) => r.tournament_id === row.tournament_id && r.pairing_group_id === group.id);
}
