// Plugin entry: runs in Vmotion's plugin worker. Tools receive a read-only project
// snapshot (PluginContext) and return a candidate; Vmotion preflights and applies it.
// ctx.scenes only holds the scenes the caller selected in `_context.sceneIds`, and only
// when the tool declares `"reads": {"scenes": true}` in plugin.json.
import { definePlugin, definePluginTool, node, type PluginCandidate } from '@vmotion/sdk';

export default definePlugin({
  name: 'Hello 插件',
  tools: {
    place_badge: definePluginTool({
      parameters: {
        sceneId: { type: 'string', default: 'intro' },
        label: { type: 'string', default: 'Hello, Vmotion' },
        accent: { type: 'color', default: '#7cf3ff' },
      },
      run(ctx, p): PluginCandidate {
        const scene = ctx.scenes.find((s) => s.id === p.sceneId);
        if (!scene) throw new Error(`Scene ${p.sceneId} is not in the context; pass _context: {sceneIds: ["${p.sceneId}"]}`);
        const badge = node({
          id: 'hello-badge',
          type: 'component',
          component: 'components/plugins/hello/badge.tsx',
          x: 0,
          y: 0,
          width: ctx.project.width,
          height: ctx.project.height,
          params: { label: p.label, accent: p.accent },
        });
        const nodes = [...scene.nodes.filter((n) => n.id !== badge.id), badge];
        return {
          operations: [{ type: 'updateScene', sceneId: scene.id, patch: { nodes } }],
          samples: [0, 30, 60].map((frame) => ({ sceneId: scene.id, frame })),
          summary: { sceneId: scene.id, placed: badge.id },
        };
      },
    }),
    count_layers: definePluginTool({
      parameters: {},
      run(ctx) {
        return { scenes: ctx.scenes.map((s) => ({ id: s.id, layers: s.nodes.length })) };
      },
    }),
  },
});
