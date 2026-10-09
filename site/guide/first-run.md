# First run: the owner account

A hub with no accounts is in **setup mode**: `GET /api/auth` reports `setupRequired: true`, and both the web app and the Android app show the *Set up your hub* screen.

## What you need

| Situation | Setup code? |
| --- | --- |
| Hub bound to loopback (`127.0.0.1`, the default for plain Node) | No |
| Hub bound to anything else (`FOXFLEET_HOST=0.0.0.0`, the Docker image) | Yes. Random, printed once at start-up as `First-run setup code (needed to create the owner account): …`. Fix your own with `FOXFLEET_SETUP_CODE`. |

The code stops anyone who can reach an unconfigured hub from claiming it first. It is compared in constant time and only asked while no account exists.

## Username and password rules

- Username: 3–32 characters, letters, digits, `.`, `_`, `-`, starting with a letter or digit.
- Password: at least 10 and at most 256 characters. Stored as an **scrypt** hash (N=2¹⁵, r=8, p=1).

## Headless alternative: `FOXFLEET_PASSWORD`

If an account store is empty and `FOXFLEET_PASSWORD` is set, the hub creates the owner `owner` from it at start-up (this exists so older single-password installs keep working). Remove the variable after your first sign-in; the password is then only a hash on disk.

## After setup

1. **Registration** is `closed` by default. Open *Admin* to switch to `invite` (people join through links you create) or `open` (anyone who reaches the hub can register: only for private networks).
2. Create a second, non-owner account only if you want to share the hub. Each user has their **own** agents, secrets, inbox and screen tickets.
3. Add agents under *Manage agents*.

Next: [Accounts and roles](/concepts/accounts).
