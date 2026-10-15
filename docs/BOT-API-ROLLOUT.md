# Bot API production rollout: `sumi` first (0.3.12-alpha)

Status: **prepared, NOT enabled.** Nothing in this repo changes a live config, service or env. Doge
confirms before any step under "Flip" runs. Decision source: HERMES-CHANNEL-PLAN.md, phase 1,
decision 1 (default: `sumi` first, connector kept as rollback for one week).

## What the hub provides (0.3.12)

| Setting | Where | Meaning |
| --- | --- | --- |
| `FOXFLEET_BOT_API=1` | hub env (`~/.config/foxfleet/env`, read by `foxfleet.service`) | Turns the bot API on (`/api/bot/ws`, `/api/bot/rpc`, `/api/bot/media`, bot-token routes, `botApi` feature). Unset = everything 404s, as today. |
| `FOXFLEET_BOT_AGENTS=sumi-native` | hub env | **New in 0.3.12.** Comma-separated agent names allowed on the bot API. Any other bot agent cannot be created (403), cannot mint a token (403), and its existing token authenticates nowhere (socket/RPC/media 401). Unset or empty = every bot agent (pre-0.3.12 behaviour). Exact, case-sensitive. |

Also in 0.3.12: authenticated bot reconnects no longer spend the per-IP login budget (a reconnect loop
behind the Cloudflare tunnel could otherwise lock humans out of login), and fatal closes 4003/1008 are
handed to Hermes' reconnect queue so the agent comes back on its own.

## Shape: side by side, connector stays

The existing connector agent **`sumi`** (machine agent from the connector) is **not** changed, renamed
or deleted. The bot is a **second** agent, **`sumi-native`** (`connection: "bot"`), served by the
FoxFleet platform plugin inside sumi's own Hermes gateway. Agent names are unique on the hub, and a
machine agent's name belongs to the connector's profile list, so side by side is what keeps the
fallback a no-op: if anything goes wrong, users keep talking to `sumi` as today.

## Flip (only after Doge confirms)

Hub host (DogeMint, user `dogetinker`, `foxfleet.service`, data root `~/.local/share/foxfleet`):

1. Deploy a build that contains 0.3.12 (`FOXFLEET_BOT_AGENTS` exists). With the auto-update cron
   still paused, deploy by hand and record the commit.
2. Back up first: `cp ~/.config/foxfleet/env ~/.config/foxfleet/env.pre-bot-$(date +%Y%m%d%H%M)` and
   snapshot the data root (config.json, `bot/`, `tokens.json` if present).
3. Add to `~/.config/foxfleet/env` (mode 600):
   ```
   FOXFLEET_BOT_API=1
   FOXFLEET_BOT_AGENTS=sumi-native
   ```
4. `systemctl --user restart foxfleet.service`; check `GET /api/auth` lists `botApi` in `hub.features`
   and the existing six agents still answer (connector path unchanged).
5. As the owner: `POST /api/connections {"kind":"hermes","connection":"bot","name":"sumi-native"}`, then
   `POST /api/agents/sumi-native/bot-token`. The token is shown **once**; it goes straight into sumi's
   profile `.env`, never into git, chat or logs.

Sumi's Hermes profile (host running sumi's gateway; UNVERIFIED which machine, check before step 6):

6. Install the plugin from the same commit (`hermes-plugin/README.md` "Install"):
   `cp -r hermes-plugin/foxfleet "$HERMES_HOME/plugins/foxfleet"` and
   `hermes --profile sumi plugins enable foxfleet`.
7. Profile `.env`: `FOXFLEET_BOT_TOKEN=ffb_…` and `FOXFLEET_ALLOWED_USERS=<Doge's hub user id>`.
8. Profile `config.yaml`:
   ```yaml
   foxfleet:
     hub_url: https://fleet.indc.io.vn
   stt:
     provider: local   # pin: voice must never auto-route to a cloud STT (Groq/OpenAI/xAI...) if keys exist
   ```
   `stt.provider: local` written in the profile's raw config.yaml is an explicit selection in Hermes
   (`tools/transcription_tools.py` `_get_provider` + `read_selection`), so there is no silent cloud
   fallback; if no local whisper backend is installed, voice is simply not transcribed. (Voice does
   not flow through FoxFleet yet: audio arrives as a DOCUMENT until the phase-3 work.)
9. Restart sumi's gateway only (not the hub, not the connector). Expect `FoxFleet: connected` in its
   log and `sumi-native` online in the app.
10. Soran's QA (plan phase 1): 5 canary probes on a physical phone; hub restart → reconnect with no
    lost/duplicated messages; token rotation → 4001 → no retry loop.

## Rollback (any time, each step independent, fastest first)

1. **Bot only, keep hub flag:** in sumi's profile remove `FOXFLEET_BOT_TOKEN` (or
   `hermes --profile sumi plugins disable foxfleet`) and restart sumi's gateway. `sumi` (connector)
   keeps working throughout; nothing about it was touched.
2. **Cut the token at the hub:** `DELETE /api/agents/sumi-native/bot-token` → the socket closes 4001
   and the plugin stops (no retry loop by design).
3. **Whole hub back to today:** remove both lines from `~/.config/foxfleet/env` (or restore the
   `env.pre-bot-*` backup) and restart `foxfleet.service`. With the flag off every bot route 404s and
   the saved `sumi-native` agent shows offline (fail safe); delete it later if wanted. Data under
   `bot/` stays on disk until removed by hand.
4. **Code:** 0.3.12 changes are backward compatible with the flag off; reverting the deploy to the
   previous commit needs nothing else.

After one week without a rollback, decide separately about retiring the connector for sumi.

## Not verified here

- No production host, service or env was touched or inspected from this branch; host paths come from
  `design/notes/native-channel-handoff.md`.
- Which machine runs sumi's gateway, and whether its Hermes commit matches the pinned `f9bdaa3`.
- Physical-device QA.
