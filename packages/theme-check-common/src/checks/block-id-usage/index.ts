import {
  Position,
  LiquidTagNode,
  NodeTypes,
  LiquidVariableLookup,
} from '@shopify/liquid-html-parser';
import { Context, LiquidCheckDefinition, Severity, SourceCodeType } from '../../types';

export const BlockIdUsage: LiquidCheckDefinition = {
  meta: {
    code: 'BlockIdUsage',
    name: 'Do not rely on `block.id` in if/else/unless/case',
    docs: {
      description:
        'The ID is dynamically generated by Shopify and is subject to change. You should avoid relying on a literal value of this ID.',
      url: 'https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks/block_id_usage',
      recommended: true,
    },
    type: SourceCodeType.LiquidHtml,
    severity: Severity.WARNING,
    schema: {},
    targets: [],
  },

  create(context) {
    return {
      // BAD: {% if block.id == "123" %}
      // BAD: {% if block.id == some_variable %}
      // BAD: {% if block[id] == "id" or block.id %}
      // FINE: <div data-block-id="{{ block.id }}">
      // FINE: document.querySelector(`[data-block-id="${block.id}"]`)
      async Comparison(node, ancesors) {
        if (
          node.comparator === '==' &&
          node.left.type === NodeTypes.VariableLookup &&
          isUsingBlockId(node.left)
        ) {
          reportWarning(context, node.position);
        }
      },

      // BAD {% case block.id %}
      async VariableLookup(node, ancestors) {
        const parentNode = ancestors.at(-1);
        if (parentNode?.type === NodeTypes.LiquidTag && parentNode.name === 'case') {
          if (isUsingBlockId(node)) {
            reportWarning(context, node.position);
          }
        }
      },
    };
  },
};

function isUsingBlockId(node: LiquidVariableLookup) {
  return (
    node.type == NodeTypes.VariableLookup &&
    node.name === 'block' &&
    node.lookups[0] &&
    node.lookups[0].type === NodeTypes.String &&
    node.lookups[0].value === 'id'
  );
}

function reportWarning(context: any, position: Position) {
  context.report({
    message:
      'The ID is dynamically generated by Shopify and is subject to change. You should avoid relying on a literal value of this ID.',
    startIndex: position.start,
    endIndex: position.end,
  });
}