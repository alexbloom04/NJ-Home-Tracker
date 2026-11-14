"""Password-encrypt the dashboard data and the saved state.

The password comes from the SITE_PASSWORD environment variable (a GitHub Actions secret).

    python scripts/vault.py seal-site site/data        encrypt each data file -> .bin, write crypto.json
    python scripts/vault.py pack state out/state.enc   encrypt the state folder into one file
    python scripts/vault.py unpack in/state.enc state  decrypt it back

Format (matches site/app.js): PBKDF2-HMAC-SHA256 key, AES-256-GCM, file = 12-byte nonce + ciphertext+tag
of the gzipped content.
"""

import base64
import gzip
import io
import json
import os
import sys
import tarfile
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ITERATIONS = 600_000
CHECK = b"nj-home-tracker"


def password():
    pw = os.environ.get("SITE_PASSWORD", "")
    if not pw:
        sys.exit("SITE_PASSWORD is not set. Add it under Settings > Secrets and variables > Actions.")
    return pw.encode()


def derive(salt):
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS)
    return AESGCM(kdf.derive(password()))


def seal(aes, data):
    nonce = os.urandom(12)
    return nonce + aes.encrypt(nonce, data, None)


def open_(aes, blob):
    return aes.decrypt(blob[:12], blob[12:], None)


def get_salt(path):
    """Keep one salt across runs so a browser that remembers the key keeps working."""
    p = Path(path)
    if p.exists():
        return base64.b64decode(p.read_text().strip())
    salt = os.urandom(16)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(base64.b64encode(salt).decode())
    return salt


def seal_site(data_dir, salt_file):
    root = Path(data_dir)
    salt = get_salt(salt_file)
    aes = derive(salt)
    files = [p for p in root.rglob("*.json") if p.name != "crypto.json"]
    for p in files:
        p.with_suffix(".bin").write_bytes(seal(aes, gzip.compress(p.read_bytes(), 6)))
        p.unlink()
    (root / "crypto.json").write_text(json.dumps({
        "salt": base64.b64encode(salt).decode(),
        "iter": ITERATIONS,
        "check": base64.b64encode(seal(aes, gzip.compress(CHECK))).decode(),
    }))
    print(f"Encrypted {len(files)} data files")


def pack(state_dir, out_file, salt_file):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for p in sorted(Path(state_dir).iterdir()):
            if p.name in ("site_data", "prev.json", "salt.txt") or p.suffix == ".enc":
                continue
            tar.add(p, arcname=p.name)
    aes = derive(get_salt(salt_file))
    Path(out_file).parent.mkdir(parents=True, exist_ok=True)
    Path(out_file).write_bytes(seal(aes, buf.getvalue()))
    print(f"Packed state into {out_file}")


def unpack(in_file, state_dir, salt_file):
    aes = derive(get_salt(salt_file))
    try:
        data = open_(aes, Path(in_file).read_bytes())
    except Exception:
        sys.exit("Could not decrypt saved state: SITE_PASSWORD changed? "
                 "Delete the `data` branch to start fresh with the new password.")
    Path(state_dir).mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        tar.extractall(state_dir, filter="data")
    print(f"Unpacked state into {state_dir}")


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    salt_file = os.environ.get("SALT_FILE", "state/salt.txt")
    if cmd == "seal-site":
        seal_site(args[0], salt_file)
    elif cmd == "pack":
        pack(args[0], args[1], salt_file)
    elif cmd == "unpack":
        unpack(args[0], args[1], salt_file)
    else:
        sys.exit(f"Unknown command {cmd}")
