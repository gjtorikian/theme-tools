import { expect, describe, it } from 'vitest';
import { highlightedOffenses, runLiquidCheck } from '../../test';
import { BlockIdUsage } from './index';

describe('Module: ContentForHeaderModification', () => {
  it('reports offense with the use of block.id in an if liquid tag', async () => {
    const sourceCode = `
      {% if block.id == '123' %}
        No bueno
      {% endif %}
    `;

    const offenses = await runLiquidCheck(BlockIdUsage, sourceCode);
    expect(offenses).toHaveLength(1);
    expect(offenses[0].message).toEqual(
      'The ID is dynamically generated by Shopify and is subject to change. You should avoid relying on a literal value of this ID.',
    );

    const highlights = highlightedOffenses({ 'file.liquid': sourceCode }, offenses);
    expect(highlights).toEqual(["block.id == '123'"]);
  });

  it('reports offense with the use of block.id in an elseif liquid tag', async () => {
    const sourceCode = `
      {% if potato == '123' %}
        No bueno
      {% elsif block.id == '123' %}
        No bueno
      {% endif %}
    `;

    const offenses = await runLiquidCheck(BlockIdUsage, sourceCode);
    expect(offenses).toHaveLength(1);
    expect(offenses[0].message).toEqual(
      'The ID is dynamically generated by Shopify and is subject to change. You should avoid relying on a literal value of this ID.',
    );

    const highlights = highlightedOffenses({ 'file.liquid': sourceCode }, offenses);
    expect(highlights).toEqual(["block.id == '123'"]);
  });

  it('reports offense with the use of block.id in an unless liquid tag', async () => {
    const sourceCode = `
      {% unless block.id == '123' %}
        No bueno
      {% endunless %}
    `;

    const offenses = await runLiquidCheck(BlockIdUsage, sourceCode);
    expect(offenses).toHaveLength(1);
    expect(offenses[0].message).toEqual(
      'The ID is dynamically generated by Shopify and is subject to change. You should avoid relying on a literal value of this ID.',
    );

    const highlights = highlightedOffenses({ 'file.liquid': sourceCode }, offenses);
    expect(highlights).toEqual(["block.id == '123'"]);
  });

  it('reports offense with the use of block.id in a case liquid tag', async () => {
    const sourceCode = `
      {% case block.id %}
        {% when '123' %}
          No bueno
      {% endcase %}
    `;

    const offenses = await runLiquidCheck(BlockIdUsage, sourceCode);
    expect(offenses).toHaveLength(1);
    expect(offenses[0].message).toEqual(
      'The ID is dynamically generated by Shopify and is subject to change. You should avoid relying on a literal value of this ID.',
    );

    const highlights = highlightedOffenses({ 'file.liquid': sourceCode }, offenses);
    expect(highlights).toEqual(['block.id']);
  });
});