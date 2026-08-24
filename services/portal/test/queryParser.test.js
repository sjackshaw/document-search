const { parseQuery } = require('../src/queryParser');

describe('parseQuery', () => {
  test('strips noise words', () => {
    const result = parseQuery('search for dental coverage limits');
    expect(result.cleanedQuery).not.toContain('search for');
  });

  test('detects explicit category prefix', () => {
    const result = parseQuery('category:dental how to file a claim');
    expect(result.category).toBe('dental');
    expect(result.cleanedQuery).toBe('how to file a claim');
  });

  test('detects implicit category from keywords', () => {
    const result = parseQuery('401k matching contributions');
    expect(result.category).toBe('retirement');
  });

  test('returns null category when no match', () => {
    const result = parseQuery('open enrollment dates');
    expect(result.category).toBeNull();
  });

  test('preserves raw query', () => {
    const result = parseQuery('  Show me dental plans  ');
    expect(result.rawQuery).toBe('  Show me dental plans  ');
  });
});
