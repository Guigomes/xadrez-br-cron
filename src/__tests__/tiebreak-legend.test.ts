import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTiebreakLegend } from '../import-standings.js';

describe('parseTiebreakLegend', () => {
  it('lê a legenda de desempates do chess-results (pontos como desempate 1)', () => {
    const html = `<td>Desempate 1: points (game-points)</td><br>
      <td>Desempate 2: Direct Encounter (DE) (Forfeited games count)</td>
      <td>Desempate&nbsp;3: Buchholz Tie-Break Variable (2023) (Gamepoints)</td>
      <td>Desempate 4: Buchholz Tie-Break Variable (2023) (Gamepoints, Cut1)</td>
      <td>Desempate 5: Sonneborn Berger Tie-Break Variable (2023) (Gamepoints)</td>`;
    const legend = parseTiebreakLegend(html);
    assert.equal(legend.get(1), 'points (game-points)');
    assert.match(legend.get(4) ?? '', /Cut1/);
    assert.match(legend.get(5) ?? '', /Sonneborn/);
  });

  it('página sem legenda devolve mapa vazio', () => {
    assert.equal(parseTiebreakLegend('<table><tr><td>Pts.</td></tr></table>').size, 0);
  });
});
