// Testes que moravam na cópia do importador dentro do chess-viewer (lib/import/,
// removida em 2026-10-22). O robô é a única implementação agora, então os testes
// vêm junto. Rodar: npm test (node:test via tsx, sem dependência extra).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRows } from '../import-players.js';
import { participantIdentityKey } from '../normalize.js';

describe('parseRows do Chess-Results', () => {
  it('mapeia Gr para UF e Clube/Cidade para escola ou clube', () => {
    const rows = [
      ['Ranking inicial'],
      ['Nº.', '', 'Nome', 'ID FIDE', 'EloN', 'Gr', 'Clube/Cidade'],
      ['1', 'CM', 'Maria, Silva', '123456', '1800', 'mg', 'Colégio Exemplo'],
    ];
    const [p] = parseRows(rows);
    assert.equal(p.fullName, 'Maria Silva');
    assert.equal(p.sourceName, 'Maria, Silva');
    assert.equal(p.title, 'CM');
    assert.equal(p.state, 'MG');
    assert.equal(p.clubOrSchool, 'Colégio Exemplo');
  });

  it('preserva a ordem da fonte e guarda o nome original como alias', () => {
    const rows = [
      ['Nº.', '', 'Nome', 'ID FIDE'],
      ['1', '', 'Pietro Nishimura Caste, Fernandes', '538001900'],
    ];
    const [p] = parseRows(rows);
    assert.equal(p.fullName, 'Pietro Nishimura Caste Fernandes');
    assert.equal(p.sourceName, 'Pietro Nishimura Caste, Fernandes');
    assert.equal(p.fideId, '538001900');
  });

  it('não grava como UF um grupo que não seja uma sigla estadual', () => {
    const rows = [
      ['Nº.', '', 'Nome', 'Gr', 'Clube/Cidade'],
      ['1', '', 'Souza, João', 'U12', 'Clube Exemplo'],
    ];
    const [p] = parseRows(rows);
    assert.equal(p.state, undefined);
    assert.equal(p.clubOrSchool, 'Clube Exemplo');
  });

  it('reconhece o mesmo participante pelo nome reordenado e ranking inicial', () => {
    assert.equal(
      participantIdentityKey('de Souza Alberto Heleno Ferreira', 25),
      participantIdentityKey('Alberto Heleno Ferreira, de Souza', 25),
    );
    assert.notEqual(
      participantIdentityKey('Alberto Heleno Ferreira de Souza', 26),
      participantIdentityKey('Alberto Heleno Ferreira de Souza', 25),
    );
  });
});
