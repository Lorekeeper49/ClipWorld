/*
 * Copyright (C) 2026 Lorekeeper49
 *
 * This file is part of ClipWorld.
 *
 * ClipWorld is free software: you can redistribute it and/or modify it under the terms of the GNU
 * General Public License as published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * ClipWorld is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with ClipWorld. If not,
 * see <https://www.gnu.org/licenses/>.
 */

// The Voiceover section of the Tools window: pick a microphone, press Record, talk over the video, press Stop.
import { useEffect, useState } from 'react'
import { Btn, Field, Section, Toggle } from '../components/ui'
import { listMicrophones, toggleVoiceover } from '../engine/voiceover'
import { t, useT } from '../i18n'
import { patchSettings, useStore } from '../state/store'

/** Seconds since `since` (performance.now() time), updated a few times a second while `on`. */
function useElapsed(since: number, on: boolean): number {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(performance.now()), 250)
    return () => clearInterval(timer)
  }, [on])
  return on ? Math.max(0, (now - since) / 1000) : 0
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** The voiceover preferences (also on the Settings window's General page): microphone, and hearing the timeline. */
export function VoiceoverSettings({ testPrefix = 'voiceover' }: { testPrefix?: string }) {
  useT()
  const idle = useStore((s) => !s.voiceover)
  const device = useStore((s) => s.settings.voiceoverDevice ?? '')
  const monitor = useStore((s) => s.settings.voiceoverMonitor !== false)
  const [mics, setMics] = useState<{ id: string; label: string }[]>([])
  // The list is read again when a take ends: after the first one, the microphones have names.
  useEffect(() => {
    if (!idle) return
    let live = true
    const refresh = () => void listMicrophones().then((m) => live && setMics(m))
    refresh()
    navigator.mediaDevices?.addEventListener('devicechange', refresh)
    return () => {
      live = false
      navigator.mediaDevices?.removeEventListener('devicechange', refresh)
    }
  }, [idle])
  const missing = device && mics.length > 0 && !mics.some((m) => m.id === device)
  return (
    <>
      <Field label={t('tools.voiceover.mic')}>
        <select className="select" value={missing ? '' : device} disabled={!idle} data-testid={`${testPrefix}-mic`}
          onChange={(e) => patchSettings({ voiceoverDevice: e.target.value || undefined })}>
          <option value="">{t('tools.voiceover.defaultMic')}</option>
          {/* Microphone names come from the system, in whatever language it uses. */}
          {mics.map((m) => <option key={m.id} value={m.id} data-i18n-ignore="">{m.label}</option>)}
        </select>
      </Field>
      <Toggle label={t('tools.voiceover.monitor')} value={monitor} testId={`${testPrefix}-monitor`}
        onChange={(v) => patchSettings({ voiceoverMonitor: v })} />
    </>
  )
}

export function VoiceoverTool() {
  useT()
  const vo = useStore((s) => s.voiceover)
  const recording = vo?.phase === 'recording'
  const elapsed = useElapsed(vo?.startedAt ?? 0, recording)
  return (
    <Section title={t('tools.voiceover.title')} icon="mic">
      <VoiceoverSettings />
      <div className="voiceover-row">
        <Btn
          className={`record-btn${recording ? ' on' : ''}`} icon={recording ? 'stop' : 'record'} testId="voiceover-record"
          disabled={!!vo && !recording} onClick={toggleVoiceover}
          title={recording ? t('tools.voiceover.stopHint') : t('tools.voiceover.recordHint')}
        >
          {!vo ? t('tools.voiceover.record') : recording ? t('tools.voiceover.stop') : vo.phase === 'starting' ? t('tools.voiceover.starting') : t('tools.voiceover.saving')}
        </Btn>
        {recording && (
          <>
            <span className="timecode" data-testid="voiceover-time">{clock(elapsed)}</span>
            <div className="meter voiceover-meter" title={t('tools.voiceover.level')}>
              <div className={`meter-fill${vo.level > 0.98 ? ' hot' : ''}`} style={{ width: `${Math.min(100, vo.level * 100)}%` }} />
            </div>
          </>
        )}
      </div>
      <p className="dim small">{t('tools.voiceover.hint')}</p>
    </Section>
  )
}
