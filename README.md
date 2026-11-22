# ClipWorld

**New to ClipWorld? Read the [User Guide](DOCUMENTATION.md)**: every feature explained in plain words.

A desktop video editor built on ffmpeg. Electron + TypeScript + React.

While I vow to keep this free forever, your support helps me create many things to help others out with whatever issues they may be dealing with, so if you'd like to donate to me, do so with the following link, it'll mean a lot: https://ko-fi.com/lorekeeper49

## Run it

```bash
npm install
npm run fetch-ffmpeg   # downloads the pinned static ffmpeg 9 for this system (checksum-verified) into vendor/ffmpeg/<platform>-<arch>
npm run dev            # development, with hot reload
```

Needs Node.js 22 or newer. ffmpeg comes from [FFmpeg-Builds](https://github.com/FFmpeg-Builds/FFmpeg-Builds) (static GPL build) for Windows x64 and Linux x64/arm64, pinned to one build in `scripts/ffmpeg-build.json` so every release can carry that build's source code. `node scripts/fetch-ffmpeg.mjs --update` moves the pin to FFmpeg-Builds' newest build of the newest stable FFmpeg; the build scripts then download it the next time they run.

### Windows

`build.bat` builds `dist\win-unpacked\ClipWorld.exe` and starts it. `build.bat nolaunch` only builds, and `build.bat installer` makes the installer (bundles ffmpeg, registers `.vcws` files). The npm equivalents are `npm run package:dir` and `npm run package`. Before building, it checks that no program still has the last build open (Windows can't replace an open file) and names any that do, such as a running ClipWorld, an editor or OneDrive still uploading it.

### Linux

```bash
bash build.sh            # builds dist/linux-unpacked/clipworld and starts it
bash build.sh nolaunch   # build only
bash build.sh appimage   # ClipWorld-<version>.AppImage and clipworld-<version>.tar.gz in dist/
```

The npm equivalents are `npm run package:linux:dir` and `npm run package:linux`. Build Linux packages on Linux: Windows drops the files' execute permission and cannot make AppImages, so the Linux scripts refuse to run there. Fonts come from `fontconfig`, and hardware encoding (NVENC) is used when the NVIDIA driver supports it. On distributions that block unprivileged sandboxes (e.g. Ubuntu 24.04), an AppImage may need `--no-sandbox` to start; the `.tar.gz` build avoids that.

### Releasing (from Windows)

`release.bat` builds every download for a GitHub release into `release\v<version>\`: the Windows installer, a Windows portable zip, a Linux x64 `.tar.gz` (written with correct Linux file permissions, so it works even though it is built on Windows) and `SHA256SUMS.txt`. The version comes from `package.json`.

- `release.bat arm64` also builds a Linux arm64 `.tar.gz`.
- `release.bat publish` also creates a **draft** GitHub release for tag `v<version>`, with the files attached and `release-notes\v<version>.md` as its text. It needs the GitHub CLI (`gh`), logged in. It refuses to run with uncommitted or unpushed changes, or if that release already exists. Publish the draft on GitHub once you've checked it.
- `release.bat notest` skips the automated tests.
- **ffmpeg's source code:** the GPL asks that the complete source code of the bundled ffmpeg comes with every release. `release.bat publish` starts the **ffmpeg source code** GitHub workflow (`.github/workflows/ffmpeg-source.yml`), which attaches it to the draft as `ffmpeg-source-<build>.tar` (split into `.part00`, `.part01`… when it's over GitHub's file size limit). It holds FFmpeg, every library built into it and the FFmpeg-Builds scripts that built it (`scripts/ffmpeg-source.sh`). Publish the draft only once it has appeared: the first time for a new ffmpeg build takes up to an hour; after that, the archive is copied from the earlier release. If you upload a release by hand, run the workflow for its tag from the Actions tab.

## Workspace

Six dockable panels. Drag tabs to rearrange, split, tab together or float them. **Window ▸ Reset layout** restores the default layout.

| Panel | What it does |
|---|---|
| **Media** | Import video, audio and images (GIFs included) by button or drag-and-drop. Each video's audio tracks are extracted automatically and listed under it. Deleting an item also removes every clip that uses it. MP4 plays most smoothly: any other video shows **Convert to MP4**, which writes an MP4 next to the original (streams copied without re-encoding when possible), switches the project to it and leaves the original untouched. |
| **Subtitles** | Create subtitle tracks (several per project, each with a name, language and style: font, size, colors, outline, background box, position, line width). Add a subtitle at the playhead with **Shift+T**, set its start/end to the playhead with **[** / **]**, edit times and text in the list. Import SRT, VTT, ASS/SSA, SBV, TTML, SAMI, MicroDVD and LRC files, or a subtitle track inside a video. Export any track to SRT, WebVTT, ASS, SSA, SBV, TTML, SAMI, MicroDVD, LRC or a text transcript. **Add to timeline** puts a track into the video as a clip that can be moved, split, stretched, transformed and given effects; tracks not on the timeline are not exported with the video. |
| **Preview** | Always fits the video frame. Transport controls and a 0–100% preview volume that never affects the export. |
| **Timeline** | Split at the playhead (**Split** button or Ctrl+K), copy/cut/paste/duplicate, snapping, Ctrl+wheel zoom. **Dragging a clip's edge changes its speed** so the clip fills the new length, audio included. Alt+drag an edge to trim instead, or Ctrl+drag to loop the clip so it plays again and again to fill the new length. A negative speed (such as −100%) plays a video or audio clip backwards. A time box on the toolbar (**Ctrl+G**) jumps the playhead to a time typed as `mm:ss:ff`, `mm:ss` or seconds. |
| **Properties** | Speed (negative plays backwards), pitch and looping for the selected clip: loop count (fractions allowed), loop start and end points, an optional intro (play from the file's start into the loop) and outro (carry on past the loop end to the file's end). A partial last loop crossfades into the outro, with a warning that it may not sound seamless. |
| **Tools** | Text (any installed font, size, bold/italic, fill, outline color and width), **voiceover** (plays the timeline from the playhead while recording your microphone, then adds the take as an audio clip lined up with the video), zoom on video (start/end, focal point, easing), transform (position, scale, rotation, opacity and crop, start/end with easing), an easing graph with every curve from easings.net that you can reshape freely and save as your own presets, clip speed, masks (hide a color, hide or show areas with an image, or hide what matches a clean background or the video underneath — for clone shots), stackable filters and effects, and **presets**: save the selected clips (with their effects, text and timing) and add them to any project later. If a preset uses files the project doesn't have yet, ClipWorld asks before importing them, or imports them straight away when **Auto import media when using presets** is on. |
| **Metadata** | Export resolution and frame rate, applied live. Source-file details. |
| **Audio** | The audio tracks of the selected video, each with its own 0–500% volume, mute and level meter. |

**Filters & effects.** Video: brightness, contrast, saturation, hue, black & white, sepia, invert, color tint, gradient, blur, sharpen, pixelate, vignette, film grain, drop shadow, chroma key, flip, fade in/out. Audio: pitch shift, distortion, bitcrusher, echo, reverb, low-pass, high-pass, bass, treble, tremolo, fade in/out. Stack as many as you like, reorder them and toggle each one.

## Languages

English and Japanese, chosen in **Edit ▸ Language…** (the system language by default). The switch is immediate and covers the menus, every window, native file dialogs and error messages. Text lives in `src/locales/<language>.json`, and anything a language doesn't have yet falls back to English. [TRANSLATING.md](TRANSLATING.md) explains how to add a language.

## Files and export

- Projects save as `.vcws` (JSON), in Documents/ClipWorld/Projects unless you choose elsewhere. Media is stored by absolute path plus a path relative to the project, so a project moved together with its media still opens. Missing files can be relinked from the Media panel. Unsaved work is autosaved for crash recovery.
- **File ▸ Export…** or **Ctrl+Shift+E**: MP4, MKV, MOV, WebM, AVI, GIF (optionally transparent: empty areas see-through, and a chosen color made see-through with tolerance, softness and feather, previewed in the Export window), plus audio-only MP3, WAV, FLAC, Ogg and M4A. Codecs are H.264, H.265, VP9, AV1, ProRes and MPEG-4, with NVIDIA NVENC / Intel Quick Sync when the GPU supports them. Audio can be mixed into one track or kept as separate tracks.
- **Edit ▸ Settings…** (Ctrl+,) holds every preference: language, preview volume, the voiceover microphone, preset auto-import, window layout, the color of each kind of clip on the timeline, and keyboard shortcuts (every one can be changed).

## How it works

The project model (`src/shared/model.ts`) has two renderers:

- **Preview:** canvas compositor + Web Audio graph (`src/renderer/engine/`).
- **Export:** an ffmpeg `filter_complex` graph (`src/shared/filtergraph.ts`).

**Optional fast seeking.** If jumping around a video is slow or choppy, click **Optimize for fast seeking** on it in the Media panel. ClipWorld then builds a 720p preview copy with a keyframe every 0.5 s (roughly half a gigabyte per hour of video), in the background, at low priority, in 60-second chunks. The choice is saved in the project and can be stopped or turned off; videos the preview cannot decode at all get the copy automatically. Chunks around the playhead are built first, finished chunks are reused after a restart, and the preview switches to a chunk as soon as it exists. Export always reads the original file. The copy uses NVIDIA NVENC when the driver supports it, otherwise x264. On import, all of a video's audio tracks are extracted in one read of the file.

Each effect is defined once in `src/shared/effects.ts`. Color filters use the CSS filter-spec maths on both sides, and text and gradient overlays are rasterised by the same canvas code for both, so the export matches the preview.

## Tests

```bash
npm test          # timeline ops, easing, and real-ffmpeg exports checked with ffprobe
npm run test:e2e  # launches the app and drives import → split → stretch → volume → text/effects → save → export,
                  # plus subtitles, masks, Convert to MP4, and a sweep for untranslated text in every language
```

## License

Copyright (C) 2026 Lorekeeper49

ClipWorld is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

The bundled ffmpeg builds are also GPL v3. Their license (`LICENSE.txt`) and a note on where their source code is (`SOURCE.txt`) ship next to them, and each release's page carries their complete source code (see [Releasing](#releasing-from-windows)).
