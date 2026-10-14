# Onboarding agents

Add agents in the web app (**Manage agents → Add**) or Android (**Settings → Manage agents**). Only the owner of an account manages that account's agents; the form is drawn from `GET /api/agent-kinds`, so it always matches your hub's version.

| I want to talk to… | Guide | Auth | Needs on your side |
| --- | --- | --- | --- |
| A Hermes agent on a machine I own | [Hermes](./hermes) | machine pairing code (or dashboard login for direct) | Node 22 on that machine |
| Something else | [Write your own plugin](./write-a-plugin) (FoxFleet is Hermes-only today) | | |

Also: [Connect a real-machine agent](./real-machine) (the general recipe) and [Screen takeover setup](./screen-setup).

## Common form fields

| Field | Meaning |
| --- | --- |
| **ID** | Letters, digits, `.` `_` `-`, up to 64 characters. Used in links and URLs; cannot change later. |
| **Display name**, **Description** | Free text (64 / 280 characters). |
| **Avatar hint** | An avatar pack name or an emoji ([avatars](/apps/avatars)). |

## Test connection

Every form has **Test connection**. It probes the draft **without saving** and reports checks such as *Dashboard reachable* or *Connector online*. When you edit an existing agent, blank secret fields inherit the saved ones, so you can test without retyping a key.

::: tip Keys are write-only
After saving, the app only shows that a key *is saved on the hub*. To change it, type a new one; to keep it, leave the field blank.
:::
