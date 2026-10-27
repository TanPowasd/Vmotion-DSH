// LLM-free boot probe for a real `dsh --profile <p>` launch. Mount it with an
// overlay whose row names this file by absolute path (see README). Once the
// booted composition has `tools` and `skills`, it records the vmotion skill and
// tool registrations, runs vmotion_doctor (plus vmotion_validate and
// vmotion_frame when VMOTION_PROBE_PROJECT is set) through the real tool
// pipeline, writes a JSON report to VMOTION_PROBE_OUT (or stdout) and exits
// the process. No model is called.
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export const name = 'vmotion-dsh-boot-probe'
export const inject = ['tools', 'skills']

async function call(ctx, toolName, args) {
  const signal = AbortSignal.timeout(300_000)
  const out = await ctx.tools.execute({ callId: `probe-${randomUUID()}`, name: toolName, arguments: args, signal })
  const result = out && Array.isArray(out.results) ? out.results[0].result : out
  return {
    isError: result.isError,
    value: result.value ?? null,
    error: result.error ?? null,
    text: result.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      const report = { ok: false, pid: process.pid }
      try {
        const skills = await ctx.skills.list()
        report.skill = skills.find(s => s.name === 'vmotion') ?? null
        const def = await ctx.skills.get('vmotion')
        report.skillBodyChars = def?.content.length ?? 0
        report.vmotionTools = ctx.tools.schemas().map(s => s.name).filter(n => n.startsWith('vmotion_')).sort()
        report.doctor = await call(ctx, 'vmotion_doctor', {})
        if (process.env.VMOTION_PROBE_PROJECT) {
          report.validate = await call(ctx, 'vmotion_validate', { project: process.env.VMOTION_PROBE_PROJECT })
          report.frame = await call(ctx, 'vmotion_frame', { project: process.env.VMOTION_PROBE_PROJECT, frame: 45 })
        }
        report.ok = report.skill !== null && report.vmotionTools.length === 8 && report.doctor.isError === false
          && (report.validate === undefined || (report.validate.value?.ok === true && report.frame.isError === false))
      } catch (error) {
        report.error = String(error?.stack ?? error)
      }
      const text = JSON.stringify(report, null, 2)
      if (process.env.VMOTION_PROBE_OUT) writeFileSync(process.env.VMOTION_PROBE_OUT, text)
      else process.stdout.write(text + '\n')
      process.exit(report.ok ? 0 : 1)
    }, Number(process.env.VMOTION_PROBE_DELAY_MS ?? 3000))
    return () => clearTimeout(timer)
  })
}
