import type { SupabaseClient } from '@supabase/supabase-js';

// O Scheduler dispara a cada poucos minutos, mas uma execução real pode levar
// vários minutos — sem trava, várias execuções rodavam ao mesmo tempo escrevendo na
// mesma tournament_players (migration 072). Trava expira sozinha depois desse
// tanto de minutos caso o processo anterior tenha morrido sem liberar.
// A mesma trava vale para a sincronização direta do botão do Dev no site.
export const LOCK_STALE_MINUTES = 10;

/** true = trava conseguida, esta execução pode prosseguir. */
export async function acquireLock(supabase: SupabaseClient): Promise<boolean> {
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

export async function releaseLock(supabase: SupabaseClient): Promise<void> {
  await supabase.from('cron_import_lock').update({ locked_at: null }).eq('id', 1);
}

export async function refreshLock(supabase: SupabaseClient): Promise<void> {
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
