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

// The speed control shared by the Tools and Properties windows. A negative speed plays the clip backwards.
import { type Clip, MAX_SPEED, MIN_SPEED, reversible, signedSpeed } from '@shared/model'
import { setClipSpeed } from '@shared/timeline-ops'
import { Slider } from '../components/ui'
import { t } from '../i18n'
import { edit, mediaOf, useStore } from '../state/store'

export function SpeedField({ clip, label, testId }: { clip: Clip; label: string; testId: string }) {
  const media = useStore((s) => mediaOf(s, clip.mediaId))
  const back = reversible(clip, media)
  const setSpeed = (v: number) => {
    // A speed too close to zero to play becomes the slowest speed, keeping the direction it had.
    const signed = Math.abs(v) < MIN_SPEED ? (v < 0 || (v === 0 && clip.reverse) ? -MIN_SPEED : MIN_SPEED) : v
    edit((p) => { setClipSpeed(p, clip.id, back ? signed : Math.abs(signed)) }, { key: `${clip.id}:speed` })
  }
  return (
    <>
      <Slider label={label} value={signedSpeed(clip)} min={back ? -8 : 0.1} max={8} step={0.01} display={100} unit="%" reset={1} mark={1}
        field={{ min: back ? -MAX_SPEED : MIN_SPEED, max: MAX_SPEED }} onChange={setSpeed} testId={testId} />
      {clip.reverse && <p className="dim small" data-testid="reverse-note">{t('tools.speed.reversed')}</p>}
    </>
  )
}
