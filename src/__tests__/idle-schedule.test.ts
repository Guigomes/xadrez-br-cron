import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importHasRounds, shouldSkipIdle } from '../idle-schedule.js';

const now = Date.parse('2026-11-21T15:00:00Z');
const ago = (min: number) => new Date(now - min * 60_000).toISOString();

test('sem rodada: pula até completar 15 min desde a última execução', () => {
  const row = (min: number) => ({ force_requested_at: null, last_run_at: ago(min) });
  assert.equal(shouldSkipIdle(row(5), false, now, 15), true);
  assert.equal(shouldSkipIdle(row(10), false, now, 15), true);
  // ciclo seguinte pode começar alguns segundos "cedo" em relação à linha
  assert.equal(shouldSkipIdle(row(14.7), false, now, 15), false);
  assert.equal(shouldSkipIdle(row(15), false, now, 15), false);
});

test('com rodada, nunca rodou ou pedido do admin: roda sempre', () => {
  assert.equal(shouldSkipIdle({ force_requested_at: null, last_run_at: ago(5) }, true, now, 15), false);
  assert.equal(shouldSkipIdle({ force_requested_at: null, last_run_at: null }, false, now, 15), false);
  assert.equal(shouldSkipIdle({ force_requested_at: ago(1), last_run_at: ago(5) }, false, now, 15), false);
});

test('rodadas contam por grupo; sem grupo conta o torneio inteiro', () => {
  const rounds = [{ tournament_id: 't1', pairing_group_id: 'g1' }];
  const groups = [
    { id: 'g1', tournament_id: 't1', name: 'U12' },
    { id: 'g2', tournament_id: 't1', name: 'U14' },
  ];
  assert.equal(importHasRounds({ tournament_id: 't1', pairing_group_name: 'U12' }, rounds, groups), true);
  assert.equal(importHasRounds({ tournament_id: 't1', pairing_group_name: 'U14' }, rounds, groups), false);
  assert.equal(importHasRounds({ tournament_id: 't1', pairing_group_name: 'U16' }, rounds, groups), false);
  assert.equal(importHasRounds({ tournament_id: 't1', pairing_group_name: null }, rounds, groups), true);
  assert.equal(importHasRounds({ tournament_id: 't2', pairing_group_name: null }, rounds, groups), false);
});
