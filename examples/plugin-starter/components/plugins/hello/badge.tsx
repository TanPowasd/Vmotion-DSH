/** @jsxImportSource @vmotion/sdk */
// A JSX component contributed by the plugin. Pure function of the clock: seekable, deterministic.
import { defineComponent, remap, springTo, Stage } from '@vmotion/sdk';

export default defineComponent({
  name: '标题徽章',
  parameters: {
    label: { type: 'string', default: 'Hello, Vmotion' },
    accent: { type: 'color', default: '#7cf3ff' },
  },
  render(ctx, p) {
    const lift = springTo(ctx, { from: 36, to: 0, stiffness: 180, damping: 18 });
    const fade = remap(ctx.frame, [0, 12], [0, 1], { easing: 'outCubic' });
    return (
      <Stage id="stage" background="#07090f">
        <rect id="plate" x={ctx.width / 2 - 320} y={ctx.height / 2 - 70 + lift} width={640} height={140}
          radius={24} fill="#121a2b" stroke={p.accent} strokeWidth={2} opacity={fade} />
        <text id="label" x={ctx.width / 2 - 300} y={ctx.height / 2 - 30 + lift} width={600} height={60}
          align="center" fontSize={44} fontWeight={700} fill="#f4f7ff" opacity={fade}>
          {p.label}
        </text>
        <rect id="bar" x={ctx.width / 2 - 120} y={ctx.height / 2 + 44 + lift} height={5} radius={2}
          fill={p.accent} width={remap(ctx.frame, [8, 32], [0, 240])} />
      </Stage>
    );
  },
});
