# Attachments and voice

Controls appear only if the agent's capabilities allow them.

## Images (`images`)

- Attach from the gallery, take a photo (phones, via the camera input), **drag and drop** or **paste** (web) into the composer.
- Images are **downscaled on your device** to fit a budget of about 2.5 MB (long edge capped, JPEG quality reduced until it fits) and sent inline in the message, so chat bodies stay under the hub's 10 MiB limit.
- Tap an image in the conversation to open the [media viewer](./media-viewer).

## Files (`files`, Hermes)

- Choose a file; it uploads with a **progress bar** (web) to the hub, which **streams** it to the agent's upload folder. Limit **90 MiB**; the hub cleans the name (no path, control characters or leading dots).
- The message gets a file marker so the agent knows its path. If the connection drops, the upload stops and you see an error; nothing is kept on the hub.

## Voice (`voice`)

- **Web:** a microphone button appears only where the browser supports the Web Speech API; otherwise it is hidden. Speech is recognized by the **browser** (which may use its vendor's cloud service) and put into the text box for you to edit.
- **Android:** record and send; the hub forwards audio (up to 12 MiB) to the agent's transcription endpoint (`POST /api/agents/{name}/transcribe`).
