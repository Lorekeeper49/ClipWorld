// An example ClipWorld plugin in TypeScript: two effects. An effect gives ClipWorld the ffmpeg filter for
// its settings; ClipWorld runs it in the export (and for the paused preview).
import { type EffectInfo, type Params, plugin } from './clipworld.ts'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

plugin.effect('oldFilm', (params: Params, info: EffectInfo) => {
  const a = clamp(Number(params.amount ?? 0.8), 0, 1)
  // Blend between no change and sepia, by the amount.
  const mix = (keep: number, sepia: number) => (keep * (1 - a) + sepia * a).toFixed(3)
  const sepia =
    `colorchannelmixer=rr=${mix(1, 0.393)}:rg=${mix(0, 0.769)}:rb=${mix(0, 0.189)}` +
    `:gr=${mix(0, 0.349)}:gg=${mix(1, 0.686)}:gb=${mix(0, 0.168)}` +
    `:br=${mix(0, 0.272)}:bg=${mix(0, 0.534)}:bb=${mix(1, 0.131)}`
  const filters = [sepia]
  // Grain changes every frame in the export; the paused preview shows one frame of it.
  if (params.grain) filters.push(`noise=alls=${Math.round(4 + 14 * a)}:allf=t${info.preview ? '' : '+u'}`)
  return filters.join(',')
})

plugin.effect('telephone', (params: Params) => {
  const low = clamp(Number(params.low ?? 300), 20, 20000)
  const high = clamp(Number(params.high ?? 3400), low + 10, 20000)
  return `highpass=f=${low},lowpass=f=${high},volume=1.6`
})

plugin.start()
