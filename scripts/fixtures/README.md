# KeePass test fixtures

Throwaway databases containing **only fake data** (documentation address `203.0.113.10`, made-up names and passwords). The master
passwords are in the tests; they protect nothing.

| file | made by | master password | format |
|---|---|---|---|
| `pykeepass-real.kdbx` | pykeepass 4.2 (`argon2-cffi` reference implementation) | `Master-pw ünï 123!` | KDBX 4, Argon2d |
| `keepassxc-real.kdbx` | KeePassXC 2.7.6 `keepassxc-cli import` | `KpxcMaster-pw ünï 456!` | KDBX 4, AES-KDF |

They exist so the reader is checked against files written by *other* implementations, not only by the library it uses
(`kdbxweb` is no longer actively developed; the KDBX 4 format itself is stable).

## Regenerating

```sh
# pykeepass-real.kdbx
python3 -m venv /tmp/pk && /tmp/pk/bin/pip install pykeepass
/tmp/pk/bin/python scripts/fixtures/gen-pykeepass.py scripts/fixtures/pykeepass-real.kdbx

# keepassxc-real.kdbx: build a KeePass 2 XML export, then let KeePassXC itself convert it
cp scripts/fixtures/gen-keepassxc-xml.ts scripts/gen-xml.tmp.ts && node scripts/gen-xml.tmp.ts /path/to/work/in.xml && rm scripts/gen-xml.tmp.ts
docker run --rm -v /path/to/work:/w ubuntu:24.04 bash -c '
  apt-get update -qq && apt-get install -y -qq keepassxc
  PW="KpxcMaster-pw ünï 456!"
  printf "%s\n%s\n" "$PW" "$PW" | keepassxc-cli import -p -t 300 /w/in.xml /w/keepassxc-real.kdbx'
```

(The Docker bind-mount source must be visible to the Docker daemon, e.g. not a systemd `PrivateTmp` path.)

## keepassxc-real.kdbx contents

The reference values below were printed by `keepassxc-cli show -s` / `show -t` on this very file; the tests compare against them.

- `GitHub` — user `alice`, URL `https://github.com/login`, password `p@ss"w0rd ü 密码⏎line2`, tag `work`, `otp` = otpauth URI (TOTP `555931` at ≈ epoch 1793578960)
- `Legacy KeeOtp` — `otp` = `key=JBSWY3DPEHPK3PXP&size=8&step=60` (KeePassXC reads this old layout too; TOTP `91372864` at the same moment)
- `Sha256 Otp` — `otp` = otpauth URI with `algorithm=SHA256&digits=8` (TOTP `36161920`)
- `Servers/Staging root` — tags `pitg-confirm`, `prod`; protected custom field `API Key`; plain custom field `Account number`; text attachment `id_ed25519`; binary attachment `photo.bin`
- `Bank` — tagged `pitg-hidden`; `Empty pw` — empty password; `Recycle Bin/Trashed`

`pykeepass-real.kdbx` has `GitHub` (alice, TOTP otpauth), `Servers/Staging root` (tag `pitg-confirm`, custom field `API Key`), `Bank` (tag
`pitg-hidden`) and a deleted entry.
