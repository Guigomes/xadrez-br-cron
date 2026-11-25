import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRoundHeaders } from '../chess-results.js';

test('todos-contra-todos: página de emparceiramentos lista todas as rodadas', () => {
  const html = [1, 2, 3, 4, 5]
    .map((n) => `<tr><td colspan="9" class="CRg1b">${n}. Ronda a 2026/11/21 às 8h</td></tr><tr><td>1</td></tr>`)
    .join('');
  assert.deepEqual(extractRoundHeaders(html), [1, 2, 3, 4, 5]);
});

test('ordem decrescente e repetições viram lista ordenada sem repetição', () => {
  const html = '<td>3. Ronda</td><td>2. Ronda</td><td>3. Ronda</td><td>1. Round</td>';
  assert.deepEqual(extractRoundHeaders(html), [1, 2, 3]);
});

test('texto que não começa a célula não conta como cabeçalho', () => {
  assert.deepEqual(extractRoundHeaders('<td>Classificação após 3 rondas</td>'), []);
});
