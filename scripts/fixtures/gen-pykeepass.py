#!/usr/bin/env python3
"""Regenerate pykeepass-real.kdbx (KDBX 4, Argon2d) — fake data only.

    python3 -m venv /tmp/pk && /tmp/pk/bin/pip install pykeepass && /tmp/pk/bin/python gen-pykeepass.py pykeepass-real.kdbx
"""
import sys
from pykeepass import create_database

out = sys.argv[1] if len(sys.argv) > 1 else "pykeepass-real.kdbx"
db = create_database(out, password="Master-pw ünï 123!")
servers = db.add_group(db.root_group, "Servers")
e = db.add_entry(servers, "Staging root", "root", 'p@ss"w0rd\nwith newline', url="ssh://203.0.113.10")  # 203.0.113.0/24 is reserved for documentation
e.set_custom_property("API Key", "custom-secret-9999", protect=True)
e.tags = ["pitg-confirm"]
gh = db.add_entry(db.root_group, "GitHub", "alice", "gh-Passw0rd-xyz", url="https://github.com/login")
gh.otp = "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&period=30&digits=6"
bank = db.add_entry(db.root_group, "Bank", "me", "bank-top-secret-1", url="https://bank.example")
bank.tags = ["pitg-hidden"]
old = db.add_entry(db.root_group, "Old", "x", "trashed-pass-12345")
db.delete_entry(old)
db.save()
