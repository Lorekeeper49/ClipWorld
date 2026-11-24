// An example ClipWorld plugin in JavaScript: a command that asks for a title and adds it at the
// playhead, and a window that lists the timeline's clips (click one to select it and go to it).
import { api, plugin } from './clipworld.mjs'

plugin.command('addTitle', async ({ playhead }) => {
  const answer = await api.askUser({
    title: 'Add a title',
    fields: [
      { key: 'text', label: 'Text', type: 'text', default: 'Hello!' },
      { key: 'seconds', label: 'Length (seconds)', type: 'number', default: 3, min: 0.5, max: 60, step: 0.5 },
      { key: 'color', label: 'Color', type: 'color', default: '#ffd84d' }
    ]
  })
  if (!answer) return // cancelled
  const id = await api.addTextClip(playhead, { content: answer.text, color: answer.color }, Number(answer.seconds))
  await api.setSelection([id])
  return `Added “${answer.text}”`
})

/** Sends the clip list to the window. */
async function sendClips() {
  const project = await api.getProject()
  const clips = project.clips
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((c) => ({ id: c.id, name: c.text?.content || c.name || c.type, type: c.type, start: c.start, duration: c.duration }))
  api.postToPanel('clips', { clips })
}

plugin.panel('clips', async (data) => {
  if (data?.action === 'refresh') await sendClips()
  if (data?.action === 'select') {
    await api.setSelection([data.id])
    await api.setPlayhead(data.start)
  }
})

plugin.start()
