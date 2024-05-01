import { describe, it, expect } from 'vitest';
import path from 'node:path';

import {
  LiquidModuleKind,
  ThemeGraph,
  ThemeModule,
  bind,
  buildThemeGraph,
  sectionModule,
  serializeThemeGraph,
  snippetModule,
  templateModule,
} from './index';

const fixturesRoot = path.join(__dirname, '../fixtures');
const dawn = path.join(fixturesRoot, 'dawn');

describe('Module: index', () => {
  describe('Unit: buildThemeGraph', () => {
    it('should build a graph of the theme', async () => {
      const graph = await buildThemeGraph(dawn);
      expect(graph).toBeDefined();
    });
  });

  describe('Unit: serializeThemeGraph', () => {
    it('should serialize the graph', () => {
      const graph: ThemeGraph = {
        entryPoints: [],
        modules: {},
        root: '/path/to/root',
      };

      const template = templateModule(graph, 'templates/index.liquid');
      const section1 = sectionModule(graph, 'section1');
      const snippet1 = snippetModule(graph, 'snippet1');
      const snippet2 = snippetModule(graph, 'snippet2');
      bind(template, section1);
      bind(section1, snippet1);
      bind(section1, snippet2);

      const section2 = sectionModule(graph, 'section2');
      bind(template, section2);

      graph.entryPoints = [template];
      [template, section1, section2, snippet1, snippet2].forEach((module) => {
        graph.modules[module.path] = module;
      });

      const { nodes, edges } = serializeThemeGraph(graph);
      expect(nodes).toHaveLength(5);
      expect(edges).toEqual([
        {
          source: 'templates/index.liquid',
          target: 'sections/section1.liquid',
        },
        {
          source: 'templates/index.liquid',
          target: 'sections/section2.liquid',
        },
        {
          source: 'sections/section1.liquid',
          target: 'snippets/snippet1.liquid',
        },
        {
          source: 'sections/section1.liquid',
          target: 'snippets/snippet2.liquid',
        },
      ]);
    });
  });
});