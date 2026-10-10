# Pictures, video and files from agents

When an agent wants to send you a file it writes a `MEDIA:` tag, the same one Hermes uses for Telegram:

```text
Here is the chart.
MEDIA:/home/me/.hermes/image_cache/chart.png
```

Foxfleet removes the tag from the text and shows a card instead:

| Kind | Extensions | Card |
| --- | --- | --- |
| Image | png, jpg, gif, webp, bmp, avif | Picture; tap for the fullscreen viewer |
| Video | mp4, mov, webm, mkv, avi, 3gp, m4v | Player; fullscreen button |
| Audio | mp3, wav, ogg, opus, m4a, flac, aac | Player; with `[[audio_as_voice]]` it is a **Voice message** |
| File | pdf, docx, xlsx, pptx, csv, txt, zip, … | Download (Android opens it with the app you choose) |

Also recognised: a Markdown image with a local path `![chart](/tmp/chart.png)`, `MEDIA:https://…` (a remote URL), and a plain link or bare URL to a video or audio file. Spaces in paths, several tags in one reply and quoted paths work. A tag inside a code block or a quote is left alone. `[[as_document]]` shows an image as a file.

## Where the file comes from

- **A remote URL:** the hub fetches it through the [SSRF-guarded proxy](/security/media-proxy#agent-media).
- **A path on the agent's computer:** the hub cannot read it, so it asks the machine's [connector](/concepts/connector), which only serves files in its shared folders. By default these are the Hermes profile's cache and workspace folders and the system temp folder. To share another folder add it to `mediaRoots` in `~/.config/foxfleet/connector.json` (or set `FOXFLEET_MEDIA_ROOTS`), then restart the connector.
- A card that cannot load says **Not available** with a Try again button. The usual reasons: the file is outside the shared folders, it is larger than 25 MiB, its type is not on the list, or the machine is offline.

## Old chats

Cards are drawn from the reply text, so earlier conversations show them again when you open them (while the file still exists on the machine).

## For agent authors

Write the tag on its own line, with an absolute path, and make sure the file exists when you send the reply. Keep files under 25 MiB. Details: [Connect an agent](/agents/hermes#sending-pictures-video-and-files).
