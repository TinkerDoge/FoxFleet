---
name: foxfleet
description: Reply well in FoxFleet chats (files, reactions, cards)
version: 0.1.0
metadata:
  hermes:
    tags: [foxfleet, chat, media, reactions]
    category: communication
---

# FoxFleet chat

FoxFleet is a chat app, used mostly on a phone. Your reply shows as a chat bubble. It is not a terminal.

## When to use
Load this skill in a FoxFleet chat when you are about to send a file, react, ask the user a question, or are unsure how something shows on the phone. The FoxFleet note in your system prompt has the shared folders, size limit and upload folder for this machine; this skill has the rest.

## Writing replies
- Markdown renders: headings, lists, tables, code blocks, links.
- Keep replies short. The screen is narrow. Avoid wide tables and long code dumps.
- Put long output (logs, reports, big code) in a file and send the file.
- Never use ANSI colors, TUI key hints ("press q"), or interactive programs (vim, less, top, a REPL). The user cannot type into them, so they hang.

## Sending files: MEDIA:
Put `MEDIA:/absolute/path` on its own line, outside any code block:

```
Here is the chart.
MEDIA:/tmp/sales-q3.png
```

- FoxFleet DOES deliver `MEDIA:` tags. Older notes, memories or skills that say FoxFleet ignores `MEDIA:` are out of date. Follow this skill instead.
- `MEDIA:` only works in your own reply text. It is not a shell command. `terminal("echo MEDIA:/tmp/x.png")`, a file holding the tag, or a script's output delivers nothing, while every command still reports success.
- Before you reply, check that each file exists and is not empty (`ls -la`). Then put the tags in that same reply.
- Images (png jpg gif webp bmp avif) and video (mp4 mov webm mkv avi 3gp m4v) show inline. Audio (mp3 wav ogg opus m4a flac aac) plays in the chat. Documents and archives (pdf docx txt md csv xlsx pptx zip tar.gz 7z epub gpx...) show as a file card.
- Not delivered: svg, html, json, xml, yaml, apk, logs and scripts. Zip them, convert them (svg to png), or paste short ones in a code block.
- Only files inside the shared folders listed in your system prompt are delivered, up to its size limit. For a file anywhere else, copy it into one of those folders (e.g. `/tmp`) first.
- Always use an absolute path. `~/` also works. A public `https://` URL works too.
- Up to 24 files per reply. Use one `MEDIA:` line per file.
- `[[audio_as_voice]]` anywhere in the reply sends audio as a voice note. `[[as_document]]` sends images as files (no preview, no recompression).
- A `MEDIA:` tag inside a code block, inline code or a `>` quote is NOT delivered. Use that to show the syntax as an example.
- A file that one of your tools made may appear on its own, but do not rely on that. Tag every file you want the user to get.
- Never say "I sent it" unless your reply holds the tag. If the user says nothing arrived, first check that the tag was in your reply text (not in a code block, not echoed by a tool), then check the folder and size limits.
- Prefer a few good images over every intermediate step.

## Files from the user
User uploads land in the upload folder named in your system prompt, as `<upload folder>/<YYYY-MM-DD>/<id>-<name>`. The user's message gives the path. Read the file from there.

## Reactions: REACT:
Put `REACT: <one emoji>` on its own line to react to the user's latest message:

```
REACT: 👍
On it.
```

- Only the first `REACT:` line counts. It must be one emoji, never a word.
- The user never sees the line, only the reaction on their message.
- A reply can be only a `REACT:` line when nothing else needs saying (e.g. the user says "thanks").
- Use reactions sparingly: thanks, good news, a joke. Not on every message.

## Replies to a message
A user message that starts with a `> ` line, then a blank line, is a reply to an earlier message. The `> ` line is an excerpt of that message, at most 140 characters (`[image]` or `[voice]` for media). Answer about that message.

## Questions and approvals
Approval requests and clarify questions show as tap-to-answer cards. Ask one question at a time, with 2 to 4 short options. Do not ask several questions in one message.

## Slash commands
These work from the phone: /compress /retry /undo /memory /skills /model /busy. For anything else, ask the user to run it in the Hermes terminal.

## Pitfalls
- Tag echoed by a shell command: not delivered. Write it in the reply.
- Tag in a code block: not delivered. Move it out of the block.
- Relative path (`./out.png`): not delivered. Use the absolute path.
- File outside the shared folders: refused. Copy it to `/tmp` first.
- `REACT: love`: ignored. Use an emoji.
