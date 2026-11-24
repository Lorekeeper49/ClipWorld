# Writing ClipWorld plugins

A plugin adds things to ClipWorld:

- **Commands**: items in the Plugins menu, with keyboard shortcuts. They can read the project and change it.
- **File types**: importers, which turn a file into clips, and exporters, which save the project in another format.
- **Effects**: picture or sound effects in the Effects list, made of ffmpeg filters.
- **Windows**: your own HTML page, docked in ClipWorld like any other window.

A plugin is a program in **any language**. ClipWorld starts it and talks to it through its standard input and output. There's a small SDK for **JavaScript**, **TypeScript**, **Python** and **Lua** that does the talking for you. Any other language can use the protocol directly, described in [The protocol](#the-protocol).

- [Your first plugin](#your-first-plugin)
- [plugin.json](#pluginjson)
- [Languages and how plugins are started](#languages-and-how-plugins-are-started)
- [Commands](#commands)
- [Importers and exporters](#importers-and-exporters)
- [Effects](#effects)
- [Windows](#windows)
- [What a plugin can ask ClipWorld](#what-a-plugin-can-ask-clipworld)
- [The project](#the-project)
- [The protocol](#the-protocol)
- [Conflicts between plugins](#conflicts-between-plugins)
- [Testing, debugging and sharing](#testing-debugging-and-sharing)

The examples in [`plugins/examples`](plugins/examples) are complete plugins, one per language:

| Example                                                 | Language   | Shows                                                    |
| ------------------------------------------------------- | ---------- | -------------------------------------------------------- |
| [hello-js](plugins/examples/hello-js)                   | JavaScript | a command that asks a question, a shortcut, and a window |
| [film-effects-ts](plugins/examples/film-effects-ts)     | TypeScript | a picture effect and a sound effect                      |
| [csv-python](plugins/examples/csv-python)               | Python     | an exporter and an importer                              |
| [clip-length-lua](plugins/examples/clip-length-lua)     | Lua        | a command that changes the selected clips                |

## Your first plugin

1. Make a folder, such as `my-plugin`.
2. Copy the SDK for your language from [`plugins/sdk`](plugins/sdk) into it (`clipworld.mjs`, `clipworld.ts`, `clipworld.py` or `clipworld.lua`).
3. Write `plugin.json`:

   ```json
   {
     "id": "yourname.hello",
     "name": "Hello",
     "version": "1.0.0",
     "main": "main.mjs",
     "commands": [{ "id": "hello", "title": "Say hello", "shortcut": "Ctrl+Alt+H" }]
   }
   ```

4. Write the program (`main.mjs` here):

   ```js
   import { api, plugin } from './clipworld.mjs'

   plugin.command('hello', async ({ selection }) => {
     await api.showMessage(`Hello! ${selection.length} clips are selected.`)
   })

   plugin.start()
   ```

5. In ClipWorld, open **Plugins ▸ Manage plugins…**, click **Install plugin…** and choose your `plugin.json`. ClipWorld loads it from where it is, so you can keep editing it. Click **Restart** to pick up changes.
6. Turn it on, then use **Plugins ▸ Say hello**, or press Ctrl+Alt+H.

The same plugin in the other languages:

```ts
// main.ts
import { api, plugin } from './clipworld.ts'
plugin.command('hello', async ({ selection }) => {
  await api.showMessage(`Hello! ${selection.length} clips are selected.`)
})
plugin.start()
```

```python
# main.py
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from clipworld import api, plugin

@plugin.command("hello")
def hello(req):
    api.show_message(f"Hello! {len(req['selection'])} clips are selected.")

plugin.start()
```

```lua
-- main.lua
package.path = (os.getenv("CLIPWORLD_PLUGIN_DIR") or ".") .. "/?.lua;" .. package.path
local cw = require("clipworld")
cw.command("hello", function(req)
  cw.api.showMessage("Hello! " .. #req.selection .. " clips are selected.")
end)
cw.start()
```

## plugin.json

| Field         | Required          | What it is                                                                                                                                  |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | yes               | A unique id: letters, digits, dots, dashes and underscores, up to 64. Use your name or domain in it, such as `yourname.hello`.               |
| `name`        | yes               | The name people see.                                                                                                                        |
| `version`     |                   | Your plugin's version, such as `1.2.0`.                                                                                                     |
| `description` |                   | One sentence about what it does.                                                                                                            |
| `author`      |                   | Who made it.                                                                                                                                |
| `apiVersion`  |                   | The protocol version it was written for. This is version **1**, the default. ClipWorld won't start a plugin that needs a newer version.   |
| `main`        | `main` or `command` | The program to run, relative to the plugin's folder. Its extension decides how it's run: see [Languages](#languages-and-how-plugins-are-started). |
| `command`     | `main` or `command` | Or the exact command line, such as `["ruby", "main.rb"]` or `["./my-plugin"]`. It runs in the plugin's folder.                            |
| `conflicts`   |                   | Ids of plugins this one doesn't work alongside. See [Conflicts](#conflicts-between-plugins).                                                |
| `commands`    |                   | See [Commands](#commands).                                                                                                                  |
| `importers`   |                   | See [Importers and exporters](#importers-and-exporters).                                                                                    |
| `exporters`   |                   | See [Importers and exporters](#importers-and-exporters).                                                                                    |
| `effects`     |                   | See [Effects](#effects).                                                                                                                    |
| `windows`     |                   | Called `panels`. See [Windows](#windows).                                                                                                   |

Any text people see (`name`, `description`, titles and labels) can be one string, or one per language: `{ "en": "Old film", "ja": "古いフィルム" }`. ClipWorld shows the one for its language, then English, then whichever is first.

If `plugin.json` has a mistake, **Manage plugins** lists the folder at the bottom with what's wrong.

## Languages and how plugins are started

| `main` ends in             | Runs with                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `.js`, `.mjs`, `.cjs`      | The Node.js inside ClipWorld (version 24). Nothing to install.                                             |
| `.ts`, `.mts`, `.cts`      | The same Node.js. It runs TypeScript directly by removing the types, so there's no build step. Use `import type` for types, and give `.ts` extensions in imports. Features that need compiling (`enum`, `namespace`, parameter properties) aren't supported. Put a `package.json` with `{ "type": "module" }` next to it (or name it `.mts`), or Node warns in the plugin's messages. |
| `.py`, `.pyw`              | Python 3 installed on the computer: `py -3` on Windows, otherwise `python3` or `python`.                   |
| `.lua`                     | Lua 5.3 or newer installed on the computer: `lua`, `lua5.4`, `lua54`, `lua5.3` or `lua53`.                 |
| anything else              | Give `command` instead.                                                                                    |

If Python or Lua isn't installed, the plugin shows **Problem** in Manage plugins with a message saying so.

Every plugin starts in its own folder, with these environment variables:

- `CLIPWORLD_PLUGIN`: its id.
- `CLIPWORLD_PLUGIN_DIR`: its folder.

Plugins are started when ClipWorld starts, if they're on, and stopped when it closes. They run in the background the whole time, so they can keep things in memory between commands.

## Commands

```json
"commands": [{ "id": "addTitle", "title": "Add a title…", "shortcut": "Ctrl+Alt+T" }]
```

- Commands appear in the **Plugins** menu. `shortcut` is optional; people can change it in **Edit ▸ Keyboard shortcuts**, where plugin commands have their own group.
- Shortcuts are written like `Ctrl+Alt+T`, `Shift+F5` or `Ctrl+Shift+K`. One already used by ClipWorld wins over yours, so pick a free one: Ctrl+Alt+letter is a good place to look.
- When it runs, the handler gets `{ command, selection, playhead }`: the selected clips' ids and the playhead time in seconds.
- Whatever it returns is shown as a message if it's a string, or an object with a `message`.
- Every change a command makes to the project is **one undo step**, however many calls it takes.
- If the handler throws an error, ClipWorld shows "The plugin ran into a problem" with the error's message.

## Importers and exporters

```json
"importers": [{ "id": "titles", "title": "titles from a CSV file", "extensions": ["csv"] }],
"exporters": [{ "id": "edl", "title": "edit decision list (EDL)", "extension": "edl" }]
```

- **Importers** appear in the File menu as **Import \<title\>…**. A file of one of its types imported any other way (the Import button, or dragging it into ClipWorld) is handed to the plugin too. The handler gets `{ importer, path, selection, playhead }` and adds what it reads with the methods below, such as `addTextClip`, `importMedia` and `addSubtitleTrack`.
- **Exporters** appear in the File menu as **Export \<title\>…**. ClipWorld asks where to save, then calls the handler with `{ exporter, path, selection, playhead }`. Read the project with `getProject` and write the file at `path`.
- Titles are shown after the words "Import" and "Export", so start them with a lowercase letter.

## Effects

```json
"effects": [{
  "id": "oldFilm",
  "title": "Old film",
  "target": "video",
  "params": [
    { "key": "amount", "label": "Amount", "type": "number", "default": 0.8, "min": 0, "max": 1, "step": 0.05 },
    { "key": "grain", "label": "Grain", "type": "boolean", "default": true }
  ]
}]
```

- `target` is `video` (the default) or `audio`. Effects appear in the Effects list under **Plugins**, with a control for each parameter.
- Parameter types:
  - `number`, with optional `min`, `max`, `step` and `unit`
  - `boolean`, shown as a switch
  - `color`, as `#rrggbb`
  - `select`, with `options: [{ "value": "a", "label": "A" }]`
- An effect doesn't change pixels itself. The handler returns an **ffmpeg filter chain** for the current settings, which ClipWorld runs:
  - Use filters separated by commas, such as `hue=s=0,eq=contrast=1.2`, with one input and one output. Filters with several inputs, or `[labels]`, aren't supported.
  - The handler gets the settings, and `info`:
    - `width`, `height` and `fps`: the frame.
    - `scale`: multiply pixel sizes by it, since sizes are given for a 1080-line frame.
    - `duration`: the clip's length.
    - `preview`: true when it's for the preview.
  - Return an empty string to leave the clip unchanged.
- **In the export**, picture effects get the clip as RGBA at its size. Whatever your filter does to the size or pixel format is undone afterwards. Sound effects get 48 kHz stereo audio.
- **In the preview**, a picture effect is shown while the preview is **paused**: ClipWorld sends that frame through your filter with ffmpeg. While playing, the clip is shown without it. Sound effects are only heard in the export.
- ClipWorld asks again whenever the settings change, so keep the handler quick, and never ask the user anything from it.
- Projects save plugin effects by plugin id and effect id. If the plugin is off when a project using its effects is exported, the export stops with a message naming the plugin.

## Windows

```json
"panels": [{ "id": "clips", "title": "Clip list", "page": "panel/index.html" }]
```

- Windows are listed in the Plugins menu. They open floating, and people can dock them like any other window.
- The page is loaded from your plugin's folder, along with its scripts, styles and pictures, using relative links.
- It runs in a sandbox: it can't reach ClipWorld or the computer itself. It talks to your plugin, which does the work:

  ```js
  // In the page: send to the plugin…
  parent.postMessage({ type: 'clipworld', data: { action: 'refresh' } }, '*')
  // …and hear back from it.
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'clipworld') show(e.data.data)
  })
  ```

  ```js
  // In the plugin:
  plugin.panel('clips', async (data) => {
    if (data.action === 'refresh') api.postToPanel('clips', { clips: (await api.getProject()).clips })
  })
  ```

## What a plugin can ask ClipWorld

Each is a request (see [The protocol](#the-protocol)). The SDKs have a function for each: `api.getProject()` in JavaScript and TypeScript, `api.get_project()` in Python, and `cw.api.getProject()` in Lua.

| Method             | Params                                                          | Answer                                                    |
| ------------------ | --------------------------------------------------------------- | --------------------------------------------------------- |
| `getProject`       |                                                                 | The project (see [The project](#the-project)).            |
| `setProject`       | `project`                                                       | Replaces the whole project, as one undo step.             |
| `getSelection`     |                                                                 | The selected clips' ids.                                  |
| `setSelection`     | `ids`                                                           |                                                           |
| `getPlayhead`      |                                                                 | The playhead time, seconds.                               |
| `setPlayhead`      | `time`                                                          |                                                           |
| `importMedia`      | `paths`                                                         | The media items for those files (imported if needed).    |
| `addMediaClip`     | `mediaId`, `start`?, `trackId`?                                 | The new clips' ids (a video brings its sound).            |
| `addTextClip`      | `start`?, `text`? (`content`, `fontFamily`, `fontSize`, `color`…), `duration`? | The new clip's id.                         |
| `updateClip`       | `id`, `changes`                                                 | Changes the clip. Objects such as `transform` are merged, so `{ transform: { start: { x: 100 } } }` changes only that value. |
| `removeClips`      | `ids`                                                           |                                                           |
| `addEffect`        | `clipId`, `type`, `params`?                                     | The new effect's id. `type` is a built-in effect (`blur`, `brightness`…) or one of this plugin's effect ids. |
| `addSubtitleTrack` | `name`, `cues` (`{ start, end, text }`), `language`?, `addClip`? | `{ trackId, clipId }`. Puts it on the timeline unless `addClip` is false. |
| `showMessage`      | `text`, `kind`? (`info` or `error`)                             |                                                           |
| `askUser`          | `title`, `message`?, `okLabel`?, `fields`                       | `{ key: value }`, or null if cancelled.                   |
| `pickFile`         | `save`?, `title`?, `defaultName`?, `filters`? (`[{ name, extensions }]`) | A path, or null if cancelled.                    |
| `getAppInfo`       |                                                                 | `{ version, language, platform, ffmpeg, ffprobe, pluginDir, dataDir }`. `ffmpeg` and `ffprobe` are paths you can run yourself; `dataDir` is a folder for your plugin's own files (create it when you need it). |
| `postToPanel`      | `panel`, `data`                                                 | A notification: sends `data` to one of your windows.      |

`askUser` fields are `{ key, label, type, default, options, min, max, step }`, with `type` one of `text`, `multiline`, `number`, `checkbox`, `select` (with `options: [{ value, label }]`) and `color`.

Edits made while one of your commands, importers or exporters runs are one undo step. Edits made at other times, such as from a window, are separate steps.

## The project

`getProject` gives the project exactly as ClipWorld keeps it. The parts plugins use most:

```jsonc
{
  "settings": { "width": 1920, "height": 1080, "fps": 30 },
  "media": [{ "id": "m1", "kind": "video", "name": "take.mp4", "path": "C:\\Footage\\take.mp4", "duration": 12.5, "width": 1920, "height": 1080 }],
  "tracks": [{ "id": "t1", "kind": "video", "name": "V1" }],
  "clips": [{
    "id": "c1", "trackId": "t1", "type": "video", "mediaId": "m1", "name": "take.mp4",
    "start": 0,       // where it starts on the timeline, seconds
    "duration": 5,    // how long it is on the timeline, seconds
    "srcIn": 2,       // where in the file it starts, seconds
    "speed": 1, "volume": 1,
    "effects": [{ "id": "e1", "type": "blur", "enabled": true, "params": { "radius": 8 } }]
  }],
  "subtitles": [{ "id": "s1", "name": "English", "cues": [{ "id": "q1", "start": 1, "end": 3, "text": "Hello" }] }]
}
```

- Clip `type` is `video`, `audio`, `image`, `text` or `subtitles`.
- Text clips have `text: { content, fontFamily, fontSize, color, … }`.
- Tracks are listed top to bottom: video tracks first (the first is in front), then audio tracks.
- A video and its sound are separate clips that share a `linkId`.
- The full shape is in [`src/shared/model.ts`](src/shared/model.ts). Anything a plugin doesn't know about is best left as it is.

## The protocol

ClipWorld and a plugin send each other [JSON-RPC 2.0](https://www.jsonrpc.org/specification) messages, **one per line**:
- ClipWorld writes to the plugin's standard input.
- The plugin writes to its standard output.
- Anything the plugin writes to standard error is kept as its **messages**, which you can read in Manage plugins.

Requests go both ways and can overlap. A request has an `id`, and the answer has the same `id` with a `result` or an `error`:

```json
{"jsonrpc":"2.0","id":7,"method":"getSelection","params":{}}
{"jsonrpc":"2.0","id":7,"result":["c1","c4"]}
{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"No clip with id \"c9\""}}
```

What ClipWorld sends a plugin:

| Message            | Kind         | Params                                                                    | Answer                       |
| ------------------ | ------------ | ------------------------------------------------------------------------- | ---------------------------- |
| `initialize`       | request      | `apiVersion`, `app` (`version`, `language`), `plugin` (`id`, `dir`)        | Anything. Answer within 15 seconds, or the plugin is marked as having a problem. |
| `command`          | request      | `command`, `selection`, `playhead`                                         | Optional message.            |
| `import`           | request      | `importer`, `path`, `selection`, `playhead`                                | Optional message.            |
| `export`           | request      | `exporter`, `path`, `selection`, `playhead`                                | Optional message.            |
| `effectFilter`     | request      | `effect`, `params`, `target`, `width`, `height`, `fps`, `scale`, `duration`, `preview` | `{ "filter": "…" }`. Answer within 20 seconds (10 for the preview). |
| `panelMessage`     | notification | `panel`, `data`                                                            |                              |
| `shutdown`         | notification |                                                                            | Finish up and exit: after 1.5 seconds the process is ended. |

What a plugin can send is in [What a plugin can ask ClipWorld](#what-a-plugin-can-ask-clipworld). While a plugin is handling one request, it can send its own requests and wait for their answers. That's how a command asks the user something, then edits the project.

A minimal plugin without an SDK, in Ruby (`"command": ["ruby", "main.rb"]`):

```ruby
require 'json'
$stdout.sync = true
STDIN.each_line do |line|
  msg = JSON.parse(line)
  next unless msg['id'] && msg['method']
  result = case msg['method']
           when 'initialize' then { ok: true }
           when 'command' then 'Hello from Ruby!'
           end
  puts({ jsonrpc: '2.0', id: msg['id'], result: result }.to_json)
end
```

## Conflicts between plugins

When someone turns a plugin on, ClipWorld checks whether it could break plugins that are already on. If so, it lists them, says why, and offers to turn them off. A conflict is when:

- either plugin lists the other in `conflicts`
- both have a command with the same shortcut (as the user has set it), so one of them would stop working
- both import the same file type, so only one of them would get those files

## Testing, debugging and sharing

- **While writing a plugin**, install it from its `plugin.json`: ClipWorld loads it from its own folder. After a change, click **Restart**. **Messages** shows what it wrote to standard error, including errors and stack traces.
- **Don't print to standard output**, since that's where messages to ClipWorld go. The SDKs send `console.log` (JavaScript and TypeScript) and `print` (Python) to standard error instead. In Lua, use `cw.log`.
- **To share a plugin**, zip its folder, with `plugin.json` at the top or in one folder inside the zip. People install it with **Install plugin…**: it's unpacked into **Documents ▸ ClipWorld ▸ Plugins ▸ \<id\>**. Installing a newer zip of the same plugin updates it.
- **Plugins are programs.** They run with the same permissions as the person using ClipWorld, and nothing checks what they do. ClipWorld warns about this each time a plugin is turned on. Say clearly what your plugin does with people's files, and share its source.
- **The SDK files are MIT licensed**, so your plugin can use any license. ClipWorld itself is GPL-3.0-or-later.
