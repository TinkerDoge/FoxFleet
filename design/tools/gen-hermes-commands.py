#!/usr/bin/env python3
"""Builds the bundled Hermes slash-command catalog from a hermes-agent checkout (hermes_cli/commands.py COMMAND_REGISTRY).

    python3 design/tools/gen-hermes-commands.py /path/to/hermes-agent

Writes server/hermes-commands.json (the hub serves it), web/src/data/hermes-commands.json and
android/app/src/main/resources/hermes-commands.json. Re-run when Hermes adds commands.

Availability through Foxfleet (a phone/browser talks to the Hermes API server, not to a terminal):
  app        Foxfleet runs it itself (new chat, stop, history, retry, rename).
  chat       Sent as a normal message; the Hermes gateway handles slash commands in chat.
             (Hermes' OpenAI-style API server does not dispatch them itself: unverified on a live agent, see docs.)
  unavailable  Terminal-only, desktop-terminal or messaging-platform-only commands.
"""
import json, sys, types, pathlib
src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/hermes-src').resolve()
sys.path.insert(0, str(src))
for n, attrs in {'utils': {'is_truthy_value': bool}, 'agent': {'__path__': []}, 'agent.i18n': {'t': lambda k, *a, **kw: k}, 'hermes_constants': {'INDICATOR_STYLES': []}}.items():
    m = types.ModuleType(n); m.__dict__.update(attrs); sys.modules[n] = m
from hermes_cli.commands import COMMAND_REGISTRY  # noqa: E402

APP = {'new': 'new', 'reset': 'new', 'stop': 'stop', 'history': 'history', 'resume': 'history', 'sessions': 'history', 'retry': 'retry', 'title': 'title'}
out = []
for c in COMMAND_REGISTRY:
    names = (c.name, *c.aliases)
    app = next((APP[n] for n in names if n in APP), None)
    if app: avail, why = 'app', ''
    elif c.gateway_only: avail, why = 'unavailable', 'Only for messaging platforms'
    elif c.cli_only and not c.gateway_config_gate: avail, why = 'unavailable', 'Terminal only'
    elif c.desktop == 'terminal': avail, why = 'unavailable', 'Needs a terminal'
    else: avail, why = 'chat', ''
    out.append({'name': c.name, 'aliases': list(c.aliases), 'description': c.description, 'category': c.category, 'args': c.args_hint, 'subcommands': list(c.subcommands), 'availability': avail, **({'app': app} if app else {}), **({'reason': why} if why else {})})
doc = {'source': 'hermes_cli/commands.py COMMAND_REGISTRY', 'count': len(out), 'commands': out}
root = pathlib.Path(__file__).resolve().parents[2]
for p in ('server/hermes-commands.json', 'web/src/data/hermes-commands.json', 'android/app/src/main/resources/hermes-commands.json'):
    (root / p).write_text(json.dumps(doc, indent=1, ensure_ascii=False) + '\n')
from collections import Counter
print(len(out), Counter(c['availability'] for c in out), Counter(c['category'] for c in out))
