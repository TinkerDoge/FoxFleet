# Resource sizing

No load testing has been done, so these are **limits from the code** and reasoned estimates, not benchmarks.

| Thing | Limit / cost | Source |
| --- | --- | --- |
| Users per hub | 1000 | `server/accounts.js` |
| Agents per user | 32 | `server/config.js` |
| Open invites | 200 | `server/accounts.js` |
| Concurrent tunnelled streams per connector | 64 | `server/connector.js` |
| File upload | 90 MiB, streamed (not buffered) | `LIMITS.file` |
| Chat request body | 10 MiB (images are about 2.5 MB each after client-side downscale) | `LIMITS.chat` |
| Voice transcribe body | 12 MiB | `LIMITS.transcribe` |
| Other JSON bodies | 4 MiB | `LIMITS.json` |
| Media-proxy image | 8 MB, 10 s | `server/media-proxy.js` |
| Password hash | scrypt N=2¹⁵, r=8: about 32 MiB of memory and tens of ms of CPU per sign-in | `server/accounts.js` |

## Practical guidance

- The hub is mostly I/O: it relays streams. A **1 vCPU / 512 MB** machine is a reasonable floor for a handful of users; the Node process itself idles at tens of MB (not measured).
- Memory spikes come from concurrent sign-ins (scrypt) and from many simultaneous 10 MiB chat bodies. The login throttles bound the first.
- Screen takeover relays VNC frames; bandwidth is the constraint, not CPU.
- Disk: JSON files in the data directory; kilobytes per agent. Backups are small.
- Build the web app on a bigger machine (or in CI) if the hub box is tiny: `npm ci && npm run build` needs a few hundred MB. Ship `web/dist` and set `FOXFLEET_SKIP_WEB=1`.
