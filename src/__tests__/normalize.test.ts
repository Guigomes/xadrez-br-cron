import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalCategoryName } from '../normalize.js';

describe('canonicalCategoryName', () => {
  it('junta U8 e U08 na mesma categoria', () => {
    assert.equal(canonicalCategoryName('U8'), 'U08');
    assert.equal(canonicalCategoryName('U08'), 'U08');
    assert.equal(canonicalCategoryName('u 8'), 'U08');
  });

  it('mantém categorias de 2 dígitos e senior', () => {
    assert.equal(canonicalCategoryName('U12'), 'U12');
    assert.equal(canonicalCategoryName('S50'), 'S50');
    assert.equal(canonicalCategoryName('s050'), 'S50');
  });

  it('não mexe em nome fora do padrão (só apara espaço)', () => {
    assert.equal(canonicalCategoryName('  Feminino  '), 'Feminino');
    assert.equal(canonicalCategoryName('Sub  Absoluto'), 'Sub Absoluto');
  });
});
