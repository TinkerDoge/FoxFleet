# Legal checklist (owner to-do)

The texts in `TERMS.md`, `PRIVACY.md` and `site/legal/user-agreement.md` are **templates, not legal advice**. Before wide distribution:

- [ ] **Entity / publisher name**: replace every `[OPERATOR NAME]` (TERMS, PRIVACY, user agreement). Do not invent a company: use your own name or your real entity.
- [ ] **Contact email**: replace `[CONTACT EMAIL]`. Use a monitored address; it is also where privacy requests for the project go. (Security reports use the GitHub advisory flow in `SECURITY.md`.)
- [ ] **Effective date**: replace `[EFFECTIVE DATE]` in TERMS and PRIVACY (and the user agreement).
- [ ] **Governing law and venue**: replace `[GOVERNING LAW / JURISDICTION]` and `[VENUE]`; decide with counsel whether to add arbitration or consumer-law wording.
- [ ] **Counsel review** of all three documents, especially: limitation of liability, the provider-terms section, screen-takeover risk wording, and GDPR/UK-GDPR/CCPA statements if you have users in those regions.
- [ ] **Version label**: `server/legal.js` (`TERMS_VERSION`, currently `1.0`) and the "Version" line in each document must match. When you change the text materially, bump all of them (hub, web fallback in `web/src/lib/terms.ts`, Android `Terms.FALLBACK_VERSION`) so people are asked to accept again.
- [ ] **Hosted URLs**: the apps link to `https://tinkerdoge.github.io/FoxFleet/legal/terms` and `.../privacy`. If the docs move, change `web/src/lib/terms.ts` and `android/.../data/Terms.kt`.
- [ ] **Hub operators** (including you) need their own privacy information for their users; the project policy covers only the project's apps and docs.
- [ ] **Trademarks**: confirm the Foxfleet name and logo are yours to use; add trademark guidance if wanted.
- [ ] **Funding links:** none exist yet. When one does, add it to `.github/FUNDING.yml`, the README Support section and the support page.
- [ ] **Play Store / other stores** (if ever): data-safety forms and a privacy-policy URL pointing at the hosted page.
