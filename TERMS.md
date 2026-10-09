# Foxfleet Terms of Use

> **Template, not legal advice.** This text was drafted as a starting point for a self-hosted open-source project. The project owner should have qualified counsel review it before wide distribution. Items in [square brackets] must be filled in; see `LEGAL-CHECKLIST.md`.

**Version:** 1.0 · **Effective date:** [EFFECTIVE DATE] · **Applies to:** the Foxfleet Android app, the Foxfleet web app, the Foxfleet documentation site, and related materials published by the project ("Foxfleet").

## 1. What this document is, and what it is not

Foxfleet is free, open-source software that **you run yourself**. There are three separate things:

1. **The software licence.** The code is licensed under the **MIT licence** (see `LICENSE`). That licence is unchanged by this document and governs what you may do with the source code.
2. **These Terms of Use.** They apply when you use the Foxfleet apps (Android and web) and read the documentation site.
3. **The [User Agreement](https://tinkerdoge.github.io/FoxFleet/legal/user-agreement)** and **[Privacy Policy](https://tinkerdoge.github.io/FoxFleet/legal/privacy).** These explain what you agree to when you create or join an account, and what data is handled.

If these Terms conflict with the MIT licence about the source code, the MIT licence wins for the code.

## 2. Who is who

- **"Hub"**: the Foxfleet server that someone installs on their own machine.
- **"Operator"**: the person or organisation that runs a hub. The operator decides who may have an account, which agents are connected, and what is stored.
- **"User"**: anyone who signs in to a hub with the apps.
- **"We" / "the project"**: [OPERATOR NAME, e.g. the individual or entity that publishes Foxfleet] and its contributors. **The project does not run a hub for you, does not host your data, and does not create accounts.** There are no Foxfleet accounts with the project.

## 3. Using Foxfleet

You may use the apps and docs for lawful purposes. You must not:

- use Foxfleet to break the law, to harm, harass or defraud anyone, or to infringe other people's rights;
- try to break into, overload or bypass the security of a hub you are not authorised to use;
- use an agent or provider through Foxfleet in a way that its own terms forbid (see section 5);
- remove licence notices or misrepresent who wrote the software.

If you are the operator of a hub, you are responsible for the people you give accounts to and for the data you collect from them (see the Privacy Policy and your local law).

## 4. Agents, tools and your content

Foxfleet connects to AI agents and AI provider services. Their output can be **wrong, unsafe or offensive**. You are responsible for checking it before relying on it and for what you ask agents to do.

- Content you send and receive (messages, images, files, audio) goes to the agent or provider you choose and is stored on the operator's hub as configured. The project never receives it.
- You keep your rights in your content. You are responsible for having the right to send it to the agent.

## 5. Third-party agents, providers and their terms

Foxfleet does not provide any AI model. When you add an agent, **you** enter into a relationship with that agent's provider, and **you are responsible for complying with their terms, usage policies, rate limits and fees.** Examples, which are not exhaustive:

- **OpenAI**, **Anthropic**, **Z.ai**, **xAI**, **OpenRouter**, **OpenCode** and others each have their own terms of service, acceptable-use policies and pricing. Read them before connecting an API key.
- **Subscription logins are not API access.** Consumer subscriptions such as ChatGPT or Claude plans, and plan-specific endpoints (for example the Z.ai "Coding Plan" endpoint), are often licensed only for the provider's own or officially supported tools. Foxfleet is **not** an officially supported tool of any provider. Do **not** use subscription logins, session cookies or plan-restricted keys with Foxfleet unless the provider's terms clearly allow it. Foxfleet warns about this where it knows of a restriction, but the warning is not a guarantee, and **using such credentials can get your account suspended**.
- API keys you enter are stored by the hub operator on their hub. Use keys with spending limits where possible.
- The project is not affiliated with, endorsed by or sponsored by any provider named here. Names are used only to describe compatibility.

## 6. Screen takeover and agents that act on real machines

Some agents can run commands, edit files and use a desktop. **Screen takeover lets you (or a person you share a hub with) see and control an agent's desktop. You use it entirely at your own risk.** Anything done on that desktop, by you or by the agent, may affect real files, accounts and systems. Do not leave sensitive sessions open on a desktop you share, and do not enter passwords you are not comfortable exposing to the machine's owner. Control ends automatically after a time limit, but you remain responsible for what happened while you had it.

## 7. Your data stays on your hub

Messages, files, agent settings and API keys are stored on the **operator's hub**, not with the project. The project cannot read, recover, delete or restore that data for you. Back it up. See the Privacy Policy.

## 8. No accounts with the project; security reporting

There is no Foxfleet-run service to sign up for. If you find a security problem, report it privately as described in `SECURITY.md` (GitHub security advisory) and please do not publish details until it can be fixed.

## 9. No warranty

Foxfleet is **alpha software**. To the maximum extent permitted by law, it is provided **"as is" and "as available", without warranties of any kind**, express or implied, including merchantability, fitness for a particular purpose, non-infringement, availability, accuracy of agent output, and security. Nothing in the docs is professional advice.

## 10. Limitation of liability

To the maximum extent permitted by law, the project, its contributors and its publisher are **not liable** for any indirect, incidental, special, consequential or punitive damages, or for loss of data, profits, goodwill or business, or for charges from third-party providers, arising out of or related to your use of Foxfleet, even if advised of the possibility. Where liability cannot be excluded, it is limited to the amount you paid the project for Foxfleet, which for free software is zero. Some jurisdictions do not allow certain exclusions; then these apply only as far as the law permits. Nothing here limits liability that cannot be limited by law (for example for fraud or for death or personal injury caused by negligence, where applicable).

## 11. Termination

You may stop using Foxfleet at any time by uninstalling the apps and not using the docs. We may withdraw the docs site, the apps or releases at any time. Operators may suspend or delete accounts on their hubs under their own rules. Sections that by their nature should survive (disclaimers, limitations, third-party responsibility) do so.

## 12. Changes

We may update these Terms and the Privacy Policy. The version number at the top changes when the text changes materially, and the apps then ask for acceptance again where they require it. Continued use after a change means you accept the new version. Earlier versions remain in the repository history.

## 13. Governing law and disputes

These Terms are governed by the laws of [GOVERNING LAW / JURISDICTION], without regard to conflict-of-law rules, and the courts of [VENUE] have jurisdiction, except where mandatory consumer law gives you other rights. [OPTIONAL: dispute-resolution or arbitration clause, to be decided with counsel.]

## 14. Contact

[CONTACT EMAIL] · Project repository: <https://github.com/TinkerDoge/FoxFleet> · Security: see `SECURITY.md`.
