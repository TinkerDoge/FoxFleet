# Foxfleet Privacy Policy

> **Template, not legal advice.** This text is a starting point for a self-hosted open-source project. The project owner should have qualified counsel review it before wide distribution, especially if you serve users in the EU/UK (GDPR), California (CCPA) or other regulated places. Items in [square brackets] must be filled in; see `LEGAL-CHECKLIST.md`.

**Version:** 1.0 · **Effective date:** [EFFECTIVE DATE]

## In one paragraph

**The Foxfleet apps and documentation site collect nothing about you and send nothing to the project.** There is no Foxfleet account with the project, no analytics, no advertising, no crash reporting and no tracking. Everything you do in Foxfleet happens between your device and **the hub you connect to**, which is run by someone else (maybe you). What that hub stores is decided by its operator.

## 1. Who controls what

| Party | What they handle |
| --- | --- |
| **The project** ([OPERATOR NAME]) | Publishes code and docs. Receives no user data from the apps. Cannot see any hub. |
| **The hub operator** | Runs the server. Controls accounts, agents, stored keys and logs. This is the "data controller" for the data on the hub. If you are not the operator, ask them for their own privacy information. |
| **Agent and AI providers** | Receive what you send to an agent you (or the operator) connected, under their own privacy policies. |

## 2. What the apps and the docs site do

- **Android and web apps:** talk only to the hub address you enter (and, in the web app, to the hub that served it). They keep a few settings on your device (hub addresses, theme, which terms version you accepted, avatars you picked). The web app is installable and caches its own files for offline start-up; it never caches your chats or API responses.
- **Documentation site (GitHub Pages):** static pages. The project adds no analytics, cookies or third-party fonts, scripts or icon services. **GitHub**, which hosts the site and the repository, may log visits under [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement); the project does not receive that data.
- Links in the docs to other sites (provider docs, GitHub) are governed by those sites.

## 3. What a hub stores (decided by its operator)

Depending on how it is configured, a hub stores on its own disk: usernames, scrypt password hashes, the terms version and time you accepted, sign-in devices (name, kind, timestamps, IP address and browser identification string of the sign-in), agent settings including **API keys and addresses entered by the user**, conversations of MCP-inbox agents, and the server's technical logs. Messages with provider agents are sent to the provider and are **not** kept by the hub, except as the provider or the operator's own logging does. Files you upload are streamed to the agent's machine. The hub **does not log request bodies or secrets**. A hub administrator who controls the machine can in principle read anything stored on it.

Hub operators: you decide retention, backups and access. You are responsible for informing your users, securing the machine, and honouring access/deletion requests under the laws that apply to you. Foxfleet's data is plain files in the data directory (see the docs, "Data directory"), which makes export and deletion straightforward.

## 4. Android permissions, and why

| Permission | Why | Notes |
| --- | --- | --- |
| **Internet** | Talk to your hub. | Always required. |
| **Microphone** (`RECORD_AUDIO`) | Voice input in chat. | Asked only when you tap the microphone. Android's speech-recognition service or the hub's transcription (if the agent supports it) processes the audio; with Google's recognition service, Google's terms apply. Denying it only disables voice. |
| **Camera** | **Not requested.** | QR scanning uses the Google code scanner, which runs in Google Play services and needs no camera permission in the app. Photos use the system camera or picker. |
| **Notifications** | **Not requested.** | |
| **Location, contacts, storage-wide access** | **Not requested.** | Files and images are chosen through the system picker. |

**Google code scanner / Play services.** The QR scanner is provided by Google Play services (ML Kit). Google's own terms and privacy policy apply to that component; the app does not receive the camera image, only the scanned text. Without Play services you can type the hub address instead.

The app disables Android cloud backup of its data (`allowBackup=false`).

## 5. Sharing and sale

The project does not sell or share personal data; it does not have any. A hub operator may share data only as they decide and as the law allows. Providers receive what you send them.

## 6. Security

Passwords are stored as scrypt hashes; sessions use rotating tokens that can be revoked; secrets are write-only in the API. No system is perfectly secure. See the Security section of the docs for the threat model and known limitations.

## 7. Your choices and rights

Because the project holds no data about you, requests to access, correct, export or delete data must go to the **hub operator**. You can delete your local app data by clearing the app's storage or uninstalling it, and revoke devices in the app. If you are in a jurisdiction with data-protection rights, you can also contact the operator's supervisory authority. For questions about this policy: [CONTACT EMAIL].

## 8. Children

Foxfleet is not directed at children. Operators who allow minors on a hub are responsible for complying with the applicable law.

## 9. International transfers

Data moves only between your device, the hub and the providers you choose; where those are located is up to you and the operator.

## 10. Changes

We update this policy by changing this file and the version number. The apps ask for acceptance of the new version where they require it. Older versions are in the repository history.

## 11. Contact

[CONTACT EMAIL] · [OPERATOR NAME] · <https://github.com/TinkerDoge/FoxFleet>
