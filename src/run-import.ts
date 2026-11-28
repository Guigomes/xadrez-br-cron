import type { SupabaseClient } from '@supabase/supabase-js';
import { processImport } from './process-tournament.js';
import { notifyImportStatus } from './notify.js';

/** Linha de tournament_imports com o necessário para importar e registrar o resultado. */
export interface ImportRunRow {
  id: string;
  tournament_id: string;
  base_url: string;
  pairing_group_name: string | null;
  /** false: ignora a coluna "Tipo" da fonte (sem categoria). */
  import_source_categories?: boolean;
  /** Estado da execução anterior — pra avisar o dev só quando muda. */
  last_status: string | null;
  last_message: string | null;
}

export type ImportRunResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

/**
 * Importa uma linha e grava last_run_at/last_status/last_message, como o robô
 * sempre fez. Usado pelo robô (index.ts) e pela sincronização direta do site
 * (botão do Dev), para as duas gravarem o mesmo resultado.
 */
export async function runImportRow(supabase: SupabaseClient, row: ImportRunRow): Promise<ImportRunResult> {
  const startedAt = new Date().toISOString();
  try {
    const summary = await processImport(supabase, row);
    await supabase
      .from('tournament_imports')
      .update({ last_run_at: startedAt, last_status: 'success', last_message: summary.slice(0, 500) })
      .eq('id', row.id);
    if (row.last_status === 'error') {
      await notifyImportStatus({ tournamentId: row.tournament_id, groupName: row.pairing_group_name, status: 'recovered' });
    }
    return { ok: true, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from('tournament_imports')
      .update({ last_run_at: startedAt, last_status: 'error', last_message: message.slice(0, 500) })
      .eq('id', row.id);
    // Avisa o dev quando quebra, ou quando o motivo do erro muda — não a cada ciclo.
    if (row.last_status !== 'error' || (row.last_message ?? '') !== message.slice(0, 500)) {
      await notifyImportStatus({ tournamentId: row.tournament_id, groupName: row.pairing_group_name, status: 'error', message });
    }
    return { ok: false, error: message };
  }
}
