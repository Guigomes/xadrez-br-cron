// Ponto de entrada do importador como biblioteca. O chess-viewer instala este
// repositório como dependência (github:Guigomes/xadrez-br-cron#<commit>) e usa
// estas funções no botão "Dev: sincronizar agora" — a implementação continua
// sendo uma só, a deste repositório.
export { runImportRow, type ImportRunRow, type ImportRunResult } from './run-import.js';
export { acquireLock, releaseLock, refreshLock, LOCK_STALE_MINUTES } from './lock.js';
export { notifyTournamentSummary } from './notify.js';
