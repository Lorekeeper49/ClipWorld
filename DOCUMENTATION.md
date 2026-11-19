# ClipWorld User Guide

This guide explains everything ClipWorld can do, in plain words. You don't need to read it from top to bottom: jump to whatever you need.

> **Note:** This guide is updated while ClipWorld is being developed, not only when a new version is released. So it may describe features that aren't in the latest release yet. If something here is missing from your copy of ClipWorld, it will arrive in a future version. To see what a particular version includes, check its release notes on GitHub.

- [The basics](#the-basics)
- [Your first edit, step by step](#your-first-edit-step-by-step)
- [The windows](#the-windows)
  - [Media](#media)
  - [Preview](#preview)
  - [Timeline](#timeline)
  - [Tools](#tools)
  - [Properties](#properties)
  - [Audio](#audio)
  - [Metadata](#metadata)
  - [Subtitles](#subtitles)
- [Effects and filters](#effects-and-filters)
- [Masks](#masks)
- [Presets](#presets)
- [Exporting your video](#exporting-your-video)
- [Saving and opening projects](#saving-and-opening-projects)
- [Settings](#settings)
- [Menus](#menus)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Language](#language)
- [Tips and fixing problems](#tips-and-fixing-problems)

---

## The basics

A few words this guide uses a lot:

- **Media**: the files you bring in to edit, such as videos, music, sound recordings and pictures.
- **Clip**: one piece of media placed on the timeline. You can use the same file many times, and each use is its own clip.
- **Timeline**: the long strip at the bottom where you arrange clips in time, left to right.
- **Track**: one row of the timeline. Video tracks hold pictures, text and video. Audio tracks hold sound. Higher video tracks are drawn **on top of** lower ones.
- **Playhead**: the red line on the timeline. It marks the moment shown in the preview, and it's where most "add" and "split" actions happen.
- **Project**: your whole edit, saved as a `.vcws` file. A project remembers where your media files are but doesn't contain them, so keep your media files where they are.
- **Export**: turning your project into a finished video (or audio) file you can share.

ClipWorld never changes your original files. Everything you do is an instruction stored in the project, and it's only applied when you export.

## Your first edit, step by step

1. **Bring in your files.** Click **Import** in the Media window, or drag files from your computer onto it.
2. **Put them on the timeline.** Drag a file from the Media window onto the timeline, or double-click it to drop it at the playhead.
3. **Watch it.** Press **Space** (or click the preview) to play and pause.
4. **Cut out the parts you don't want.** Move the playhead to where you want to cut and press **Ctrl+K** (or click **Split**). Click the unwanted piece and press **Delete**.
5. **Close the gaps.** Drag clips left or right to line them up. They snap neatly to each other's edges.
6. **Add a title.** Press **T** to add text at the playhead, then type your words in the Tools window.
7. **Export.** Press **Ctrl+Shift+E**, choose a format (MP4 is a safe choice), and click **Export…**.

Made a mistake? **Ctrl+Z** undoes it and **Ctrl+Y** brings it back.

---

## The windows

ClipWorld is made of several windows inside one: Media, Subtitles, Preview, Tools, Properties, Metadata, Audio and Timeline.

- **Move a window:** drag its tab to another spot. You can put it next to another window, stack it as a tab with others, or float it on its own.
- **Close a window:** click the **×** on its tab. Bring it back from the **Window** menu.
- **Get the original layout back:** **Window ▸ Reset layout**.

ClipWorld remembers your layout the next time you open it.

### Media

The Media window holds every file in your project.

**Bringing files in**

- Click **Import**, use **File ▸ Import media…** (**Ctrl+I**), or drag files onto the window.
- Videos, audio and pictures all work, including animated GIFs.
- Subtitle files (such as `.srt`) dropped here become subtitle tracks instead. See [Subtitles](#subtitles).

**What each file shows**

- A small picture, the name, its size, frame rate and length, and how many times it's used on the timeline.
- **Audio tracks:** many videos contain more than one audio track (for example game sound and a microphone). ClipWorld pulls every one out automatically and lists them under the video. Click the **audio tracks** line to show or hide that list.

**Putting files on the timeline**

- Drag the file onto the timeline, double-click it, or click its **+** button. Double-click and **+** place it at the playhead.
- To use just one of a video's audio tracks, drag that track from the list.

**Other buttons on a file**

- **Trash:** removes the file from the project **and every clip that uses it**. The file on your computer is not deleted.
- **Convert to MP4:** appears on videos that aren't MP4.
  - MP4 plays most smoothly in the preview, so this makes an MP4 copy next to the original and switches your project to use it.
  - It copies the video without re-encoding when it can, which is fast and loses no quality.
  - The original file isn't touched.
- **Optimize for fast seeking:** use this if jumping around in a video is slow or choppy.
  - It builds a lighter preview copy in the background, starting where you're working.
  - It uses about half a gigabyte of disk space per hour of video.
  - Exports always use your original file, so quality isn't affected.
  - Click the button again to stop or turn it off.
- **Locate file…:** if a file was moved or renamed, it shows **File not found** in red. Click the folder button and point ClipWorld to where the file is now.

> Tip: MP4 files give the smoothest preview. The note at the bottom of the Media window is a reminder.

### Preview

The Preview window shows your video at the playhead's position.

- **Play / pause:** click the picture, press **Space**, or use the play button.
- **Step one frame:** the buttons either side of play, or the **Left** and **Right** arrow keys.
- **Jump to the start or end:** the outer buttons, or **Home** and **End**.
- **Time display:** the current time and the total length, as `minutes:seconds:frames`.
- **Preview volume:** the slider on the right only changes how loud the preview plays (0–100%). It **does not** change your exported video. The speaker button mutes the preview.

The picture always fits the window, so you see the whole frame.

### Timeline

The timeline is where you build your video.

**Moving around**

- **Move the playhead:** click or drag on the time ruler at the top, or click an empty part of a track.
- **Zoom in and out:** hold **Ctrl** and scroll the mouse wheel, use the **−** and **+** buttons or the slider, or press **Ctrl+=** and **Ctrl+−**. The **fit** button (the four corners) shows the whole video at once.
- **Scroll:** use the scroll bars or the mouse wheel.

**Selecting clips**

- Click a clip to select it. A video's own audio clips are selected with it, because they're **linked**.
- Hold **Ctrl** or **Shift** while clicking to select several clips.
- Hold **Alt** while clicking to select one clip without the clips linked to it.
- **Ctrl+A** selects every clip. **Escape** selects none.

**Moving clips**

- Drag a clip left or right to move it in time, or up and down to move it to another track.
- Linked clips move together.
- When **snapping** is on (the magnet button, or press **S**), clips stick to the edges of other clips and to the playhead.

**Changing a clip's length**

- **Drag a clip's edge to change its speed.** Making a clip shorter speeds it up, and making it longer slows it down, so the whole clip still plays in the new length. The sound follows along.
- **Hold Alt while dragging an edge to trim instead.** This cuts off the beginning or end without changing the speed.
- **Hold Ctrl while dragging an edge to loop the clip.** The clip plays again and again (at the same speed) to fill the new length. A green **↻** badge shows how many times it loops, and dashed lines mark where each loop starts again. This works on videos and sound; see [Properties](#properties) for the loop settings.

**Cutting and copying**

- **Split** (**Ctrl+K** or the **Split** button) cuts clips in two at the playhead.
  - If any selected clips are under the playhead, only those are cut.
  - Otherwise, every clip under the playhead is cut.
- **Copy**, **Cut** and **Paste** (**Ctrl+C**, **Ctrl+X**, **Ctrl+V**): paste puts the clips at the playhead.
- **Duplicate** (**Ctrl+D**) places a copy right after the selected clips.
- **Delete** removes the selected clips.
- **Unlink** (**Ctrl+U**) separates a video from its audio so you can move or delete them separately.

**Tracks**

- **+ Video** and **+ Audio** add a new track.
- The **eye** button hides a video track. The **speaker** button mutes an audio track.
- An empty track can be removed with its **×** button (when there's at least one other track of that kind).

Clips are colour-coded: blue for video, green for audio, orange for pictures, purple for text, and gold for subtitles. You can choose your own colours in [Settings](#settings). A small **fx** badge means the clip has effects.

### Tools

The Tools window changes the selected clip. Each part folds open and closed by clicking its title.

**Text**

- **Add text** (or press **T**) puts a text clip at the playhead.
- Select a text clip to edit it:
  - **The words.** Press Enter for a new line.
  - **Font:** any font installed on your computer. Click it and type to search.
  - **Size**, **Bold** (B), **Italic** (I), and alignment (**Left**, **Center**, **Right**).
  - **Fill:** the colour of the letters.
  - **Outline** and **Outline width:** a border around the letters, which helps text stand out.

**Presets**

- Save clips and reuse them in other projects. See [Presets](#presets).

**Speed** (videos and audio)

- Plays the clip faster or slower, from 10% to 800%. 100% is normal speed. Double-click the slider to go back to 100%.
- **Keep audio pitch when speed changes:** when this is on, sped-up voices don't sound squeaky and slowed-down voices don't sound deep.

**Zoom on video**

- Slowly zooms into (or out of) the picture over the length of the clip, like a camera pushing in.
- **Start zoom** and **End zoom:** 100% is normal size, and higher numbers zoom in.
- **Focus X / Focus Y:** the point the zoom moves towards (50% / 50% is the centre).
- **Ease:** how the movement starts and stops (see [Easing](#easing) below).

**Transform**

- Moves, sizes, turns and fades the whole clip:
  - **Position X / Y:** moves the clip across the frame.
  - **Scale:** makes it bigger or smaller (100% is normal).
  - **Rotation:** turns it, in degrees.
  - **Opacity:** how see-through it is (100% is solid, 0% is invisible).
- **Animate from start to end:** gives you a **Start** and an **End** value for each setting, and the clip moves smoothly from one to the other over its length. This is how you make picture-in-picture slides, spins and fades.
- The reset button puts everything back to normal.

**Mask**

- Hides parts of a clip. See [Masks](#masks).

**Filters & effects**

- Changes how a clip looks or sounds. See [Effects and filters](#effects-and-filters).

#### Easing

Easing controls how an animation speeds up and slows down:

- **Linear:** the same speed from start to finish.
- **Ease in:** starts slowly, then speeds up.
- **Ease out:** starts quickly, then slows down to a gentle stop.
- **Ease in-out:** slow at both ends, faster in the middle. This usually looks the most natural.
- **(strong)** versions do the same thing, more noticeably.

### Properties

The Properties window (a tab next to Tools) shows the settings of the selected clip.

**Speed & pitch** (videos and audio)

- **Speed:** plays the clip faster or slower, the same as dragging its edge.
- **Pitch:** makes the sound higher or lower without changing its speed, in semitones (+12 is one octave higher, −12 one octave lower). Double-click the slider to go back to 0.
- **Keep audio pitch when speed changes:** the same switch as in the Tools window.

**Loop** (videos and audio)

Looping plays part of a file over and over. It's useful for music that needs to last longer, or a short clip that should repeat. Turn on **Loop this clip**, or hold **Ctrl** and drag the clip's edge on the timeline. A video and its sound always loop together.

- **Loop count:** how many times the loop plays. It can be a fraction: **2.5** plays it two and a half times.
- **Loop start** and **Loop end:** which part of the file repeats, in seconds from the start of the file. To make music loop seamlessly, put these on the beat, for example at the start of a bar and the start of a later bar.
- **Include intro:** plays the file from its very beginning up to the loop first, so the music starts naturally instead of jumping straight into the loop.
- **Include outro:** after the last loop, keeps playing past the loop end to the end of the file, so the music finishes naturally.
- The clip's length on the timeline follows these settings. If the next clip on the track is in the way, ClipWorld tells you there isn't room. Move or shorten that clip first.

**Partial loops and the crossfade**

- When the loop count isn't a whole number **and** the outro is on, the last loop stops part way through and has to jump to the outro.
- ClipWorld smooths that jump with a **crossfade**: the loop fades out while the outro fades in. The **Crossfade** setting is how long that takes, in seconds.
- Even so, jumping mid-phrase **may not sound right** with music, which is why a warning appears. For a seamless ending, use a whole number of loops.
- A whole number of loops never needs a crossfade, because the last loop ends exactly where the outro begins.

To stop looping, turn off **Loop this clip**: the clip plays straight through again.

### Audio

Select a video on the timeline and the Audio window shows each of its audio tracks:

- **Volume** from **0% to 500%** for each track. 100% is the original loudness, so you can make a quiet microphone louder or turn down background noise. Double-click the slider to go back to 100%.
- **Mute** button for each track.
- **Level meter:** shows how loud each track is while playing. If it turns red, the sound is too loud and may crackle.

### Metadata

The Metadata window sets the shape and smoothness of your finished video:

- **Resolution:** the size of the video in pixels. Choose a common size (1080p, 4K, vertical for phones, square) or type your own width and height.
- **Frame rate:** how many pictures per second (fps). 30 fps is standard and 60 fps is smoother. You can type any value.
- **Match "file name":** copies the size and frame rate from the selected file, which is usually what you want.
- Changes show in the preview right away and are used when you export.

It also shows information about the selected file (where it is, its size, codec and audio tracks) and the selected clip (where it starts, how long it is and its speed).

### Subtitles

The Subtitles window lets you write subtitles, style them, save them as subtitle files, and put them in your video.

**Tracks**

- Click **New subtitle track** to start. You can have several tracks, for example one per language.
- Pick a track from the drop-down at the top. Give it a name and a language underneath.

**Writing subtitles**

1. Move the playhead to where someone starts speaking.
2. Press **Shift+T** (or click **Add**). A new subtitle appears in the list, ready for typing.
3. Type the words. **Enter** finishes, and **Shift+Enter** adds a second line.
4. Adjust timing: press **[** to set the selected subtitle's start to the playhead, and **]** to set its end. You can also type times into the boxes (`hours:minutes:seconds.milliseconds`).

- Click a subtitle in the list to jump to it.
- The subtitle playing now is highlighted.
- A warning sign means a subtitle overlaps the one before it.
- **Show in preview** shows the subtitles over the video while you work, even before they're part of the video.

**Style** (click to open)

- Font, size, bold, italic, alignment, text colour, outline, and an optional background box behind the words.
- **Position:** bottom, middle or top, plus how far from the edge.
- **Line width:** how wide a line can get before the words wrap onto the next line.

**Importing subtitles**

- **Import ▸ Subtitle file…** reads SRT, WebVTT, ASS/SSA, SBV, TTML, SAMI, MicroDVD (SUB) and LRC files.
- The same menu also lists subtitle tracks found inside your project's videos (for example in MKV files), and you can bring those in too.
- Picture-based subtitles from DVDs and Blu-rays can't be imported, because they're images rather than text.

**Saving subtitles as a file**

- **Export file**, then choose a format: SRT (works almost everywhere), WebVTT (for websites), ASS (keeps your styling), SSA, YouTube SBV, TTML, SAMI, MicroDVD, LRC (song lyrics), or a plain text transcript.
- When the track is on the timeline, you can choose to match the times in your video or keep the original times.

**Putting subtitles into the video**

- Click **Add to timeline**. The track becomes a clip on the timeline, and **only then** does it appear in your exported video.
- Because it's a normal clip, you can move it, split it, stretch it, transform it and add effects (such as a drop shadow) to it.
- Tracks that aren't on the timeline stay out of the video, but you can still save them as subtitle files.

---

## Effects and filters

Select a clip, open **Filters & effects** in the Tools window, and pick an effect from the **+ Add** list.

- You can add **as many effects as you like**. They're applied from top to bottom, and the arrow buttons change the order.
- The tick box turns an effect off without removing it. The trash button removes it.
- **For a video with sound:** buttons at the top let you choose whether the effect goes on the picture or on one of its audio tracks.

**Colour**

| Effect        | What it does                                                                   |
| ------------- | ------------------------------------------------------------------------------ |
| Brightness    | Makes the picture lighter or darker.                                           |
| Contrast      | Makes the difference between light and dark stronger or weaker.                |
| Saturation    | Makes colours stronger, or fades them toward grey.                             |
| Hue shift     | Rotates every colour around the colour wheel (blues become greens, and so on). |
| Black & white | Removes colour.                                                                |
| Sepia         | Gives an old-photo brown tone.                                                 |
| Invert        | Turns the picture into its negative.                                           |
| Color tint    | Washes the picture with a colour you choose.                                   |
| Gradient      | Lays a fade from one colour to another over the picture, at any angle.         |

**Stylize**

| Effect      | What it does                                                          |
| ----------- | --------------------------------------------------------------------- |
| Blur        | Softens the picture.                                                  |
| Sharpen     | Makes edges crisper.                                                  |
| Pixelate    | Turns the picture into big blocks, for hiding faces or a retro look.  |
| Vignette    | Darkens the corners.                                                  |
| Film grain  | Adds a fine noisy texture like old film.                              |
| Drop shadow | Adds a shadow behind the clip. Great for text and picture-in-picture. |
| Chroma key  | Removes a green screen (or any background colour you pick).           |
| Flip        | Mirrors the picture left-to-right and/or upside down.                 |

**Transitions**

| Effect   | What it does                                     |
| -------- | ------------------------------------------------ |
| Fade in  | Fades the clip in from transparent at its start. |
| Fade out | Fades the clip out to transparent at its end.    |

**Audio**

| Effect             | What it does                                                       |
| ------------------ | ------------------------------------------------------------------ |
| Pitch shift        | Makes a voice or sound higher or lower without changing its speed. |
| Distortion         | Adds a gritty, overdriven sound.                                   |
| Bitcrusher         | Makes sound crunchy and lo-fi, like an old game console.           |
| Echo               | Repeats the sound with a delay.                                    |
| Reverb             | Makes it sound like it's in a big room or hall.                    |
| Low-pass (muffle)  | Cuts high sounds, like hearing through a wall.                     |
| High-pass (thin)   | Cuts low sounds, like a phone or radio.                            |
| Bass               | Turns the low end up or down.                                      |
| Treble             | Turns the high end up or down.                                     |
| Tremolo            | Makes the volume wobble up and down.                               |
| Fade in / Fade out | Fades the sound in at the start or out at the end.                 |

> Pitch shift and reverb can sound slightly different in the preview than in the export. The exported version is the accurate one.

## Masks

A mask hides parts of a clip so whatever is underneath shows through. Select a video or picture, open **Mask** in the Tools window, and click one of the three buttons. A clip can have several masks.

Every mask has:

- **Feather:** softens the edge between the hidden and visible parts.
- **Invert:** swaps what's hidden and what's shown.

**Color mask:** makes one colour invisible.

- Pick the colour.
- Raise **Tolerance** to include similar shades.
- Use **Softness** for a smoother edge.
- Unlike Chroma key, it works on any colour, including black, white and grey.

**Image mask:** uses a picture as a stencil.

- Where the picture is **white**, the clip shows. Where it's **black**, the clip is hidden. Grey is in between.
- You can also use the picture's transparency instead of its brightness.
- The picture is stretched to cover the clip.
- Choose a picture from your Media, or pick **Import a file…** to bring one in.

**Difference mask:** hides the parts of a clip that match something else. This is how you make **clone shots**, where the same person appears twice in one scene:

1. Put your camera on a tripod and don't move it. Record yourself on one side of the room, then again on the other side. Also record a second or two of the **empty room**.
2. Put both takes on the timeline, one above the other, starting at the same time.
3. Select the top take and add a **Difference** mask.
4. Set **Compare with** to **A clean background**. Under **Background**, choose your video, and set **Frame at** to a moment when the room is empty (or choose a photo of the empty room).
5. The top take now only shows where it differs from the empty room (you!), so both of you appear.

- **Tolerance** and **Softness** control how different something must be to stay visible.
- **What is underneath the clip** compares the clip against the video below it instead. This is useful for removing a background that both share, but it can't make clones by itself.

Masks are applied before the clip's other effects.

## Presets

Presets let you save clips and reuse them in any project. Good uses are a title design, an intro, a lower-third name tag, or a video with a stack of effects you like.

**Saving a preset**

1. Select one or more clips on the timeline (with or without effects).
2. In the Tools window, open **Presets**, type a name, and click **Save … clips**.

The preset keeps everything about those clips: their effects, masks, text, position, speed, volume, and how they're spaced and stacked. A video's audio tracks come along with it.

**Using a preset**

- Click **Use** next to it. The clips are added at the playhead.
- If the preset uses files that aren't in your project yet, ClipWorld asks: *"The following files need to be imported to use this preset, would you like to import them now?"*
  - **Yes** imports them and adds the clips.
  - **No** cancels.
- Tick **Auto import media when using presets** before clicking Yes to never be asked again. ClipWorld remembers this, even after restarting. You can turn it off again with the switch at the bottom of the Presets section.
- If a file has been moved or deleted since the preset was saved, it's marked **File not found**. It's added as a missing file, which you can find with **Locate file…** in the Media window.

**Managing presets**

- Click a preset's name to rename it.
- Click the trash button and then **Delete?** to remove it. Deleting a preset can't be undone.

## Exporting your video

Open the Export window with **File ▸ Export…** or **Ctrl+Shift+E**.

- **Format:**
  - **MP4** works almost everywhere and is the best default.
  - Also available: MKV, MOV, WebM, AVI and animated GIF.
  - Audio-only formats: MP3, WAV, FLAC, Ogg and M4A.
- **Video codec:** how the video is compressed.
  - **H.264** plays on everything.
  - **H.265**, **VP9** and **AV1** make smaller files but take longer to export and don't play everywhere.
  - **ProRes** is for further editing in other programs.
- **Encoder:** if your computer has an NVIDIA, Intel or AMD graphics chip that can help, you can choose it here for much faster exports. **Software** works on every computer.
- **Quality:** higher quality means a better picture and a bigger file. **High** is a good balance.
- **Audio codec** and **Audio bitrate:** a higher bitrate gives better sound and a bigger file. 192 kbps is plenty for most videos.
- **Audio tracks:** if your timeline has more than one audio track, you can mix them into one, or keep them as separate tracks (handy for editing later).

Click **Export…**, choose where to save, and watch the progress bar. You can cancel at any time. When it's done, **Show in folder** takes you to the file.

The resolution and frame rate come from the [Metadata](#metadata) window. What you see in the preview is what you get in the export.

## Saving and opening projects

- **Save** (**Ctrl+S**) and **Save as…** (**Ctrl+Shift+S**) save your project as a `.vcws` file. A dot next to the project name at the top means there are unsaved changes.
- **Open** (**Ctrl+O**) opens a project. Recent projects are listed in the **File** menu. If you installed ClipWorld with the Windows installer, double-clicking a `.vcws` file opens it.
- **Moving projects:** if you move the project file **together with** its media (for example the whole folder to another drive), it still finds everything.
- **Missing files:** if a file can't be found, it shows **File not found** in the Media window, and **Locate file…** lets you point to it.
- **If ClipWorld closes unexpectedly:** unsaved work is saved in the background, and the next time you start ClipWorld it's brought back automatically.
- **Closing with unsaved changes:** ClipWorld asks whether to save first.

## Settings

All your preferences are in one place: **Edit ▸ Settings…** or **Ctrl+,** (Ctrl and the comma key). Changes take effect straight away and are remembered the next time you open ClipWorld. They belong to you, not to a project, so they apply to every project.

**General**

- **Language:** the language ClipWorld is shown in. See [Language](#language).
- **Preview volume:** how loud the preview plays. Exported videos are not affected. This is the same slider as in the Preview window.
- **Auto import media when using presets:** use presets without being asked about missing files. See [Presets](#presets).
- **Window layout:** puts every window back where it started, if you've lost track of one.

**Timeline**

- **Clip colors:** pick the colour of each kind of clip on the timeline: video, audio, pictures, text and subtitles.
  - Click the coloured square to choose a colour, or type a colour code such as `#ff8800`.
  - The sample next to it shows how a clip will look.
  - The round-arrow button puts one colour back to its default. **Reset all colors** does them all.
  - On light colours, waveforms and subtitle blocks are drawn in dark ink so they stay easy to see.

**Keyboard shortcuts**

- Change the key for any action. See [Keyboard shortcuts](#keyboard-shortcuts).

## Menus

- **File:** new, open, recent projects, save, save as, import media, import subtitles, export, export subtitles, exit.
- **Edit:** undo, redo, cut, copy, paste, duplicate, delete, split, unlink, add text, add subtitle, select all, **Settings…**, and shortcuts straight to the **Keyboard shortcuts…** and **Language…** pages of Settings.
- **Window:** show or hide each window, **Reset layout**, and developer tools (for troubleshooting).
- **Help:** About ClipWorld.

## Keyboard shortcuts

Every shortcut can be changed in **Edit ▸ Settings… ▸ Keyboard shortcuts** (or **Edit ▸ Keyboard shortcuts…**): click a shortcut, then press the new keys. Escape cancels without changing it. These are the defaults:

| Action                               | Keys                     |
| ------------------------------------ | ------------------------ |
| New project                          | Ctrl+N                   |
| Open project                         | Ctrl+O                   |
| Save                                 | Ctrl+S                   |
| Save as                              | Ctrl+Shift+S             |
| Import media                         | Ctrl+I                   |
| Export                               | Ctrl+Shift+E             |
| Undo / Redo                          | Ctrl+Z / Ctrl+Y          |
| Cut / Copy / Paste                   | Ctrl+X / Ctrl+C / Ctrl+V |
| Duplicate                            | Ctrl+D                   |
| Delete                               | Delete                   |
| Select all clips                     | Ctrl+A                   |
| Deselect                             | Escape                   |
| Settings                             | Ctrl+,                   |
| Split at playhead                    | Ctrl+K                   |
| Unlink audio from video              | Ctrl+U                   |
| Add text                             | T                        |
| Toggle snapping                      | S                        |
| Zoom timeline in / out               | Ctrl+= / Ctrl+−         |
| Add subtitle at playhead             | Shift+T                  |
| Set subtitle start / end to playhead | [ / ]                    |
| Play / pause                         | Space                    |
| Previous / next frame                | Left / Right             |
| Back / forward 1 second              | Shift+Left / Shift+Right |
| Go to start / end                    | Home / End               |

Shortcuts don't fire while you're typing in a text box, so typing "T" in a subtitle doesn't add a text clip.

## Language

ClipWorld is available in **English** and **Japanese (日本語)**. It uses your computer's language by default.

To change it, open **Edit ▸ Language…** (or the **General** page of **Edit ▸ Settings…**) and choose a language. Everything switches immediately, with no restart. If you pick a language you can't read, the menu item always says "(Language)" in English too, so you can find your way back.

Want to help translate ClipWorld into your language? See [TRANSLATING.md](TRANSLATING.md).

## Tips and fixing problems

**The preview is choppy or slow to jump around.**

- Try **Convert to MP4** on the video in the Media window, since MP4 is the smoothest format.
- If it's still slow, click **Optimize for fast seeking**.
- Very long recordings (hours) benefit most.

**"ffmpeg not found" appears at the top.**

- ClipWorld uses a tool called ffmpeg to read and write video, and it comes included with the downloads.
- If you're running ClipWorld from its source code, run `npm run fetch-ffmpeg` in the project folder and restart.

**Exports are slow.**

- Choose a hardware **Encoder** (NVIDIA NVENC, Intel Quick Sync or AMD AMF) in the Export window if your computer offers one.
- Lowering the quality or resolution helps too.
- NVIDIA hardware encoding needs an up-to-date graphics driver.

**Windows warns about the app the first time.**

- ClipWorld isn't code-signed yet, so Windows SmartScreen may show a warning. Click **More info ▸ Run anyway**.

**On Linux, it won't start and mentions a "sandbox".**

- Start it with `./clipworld --no-sandbox`. This is common on Ubuntu 24.04 and newer.

**A file shows "File not found".**

- It was moved, renamed or deleted. Click **Locate file…** (the folder button) next to it in the Media window and choose where it is now.

**Text or subtitles look different in another font.**

- Fonts come from your computer. If you open a project on a computer without that font, a different one is used. Pick a font both computers have.

**I lost my layout or a window disappeared.**

- Use the **Window** menu to reopen it, or **Window ▸ Reset layout**.
