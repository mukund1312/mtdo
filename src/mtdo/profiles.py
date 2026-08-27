"""Multiple named profiles -- each a fully separate goals.json + state.json +
reports/, the same way OS user accounts or browser profiles isolate data. Lets one
mtdo install serve genuinely different tracks (a DSA-grind plan, a college-application
plan, a friend's own plan on a shared machine, ...) without any of them sharing
streaks, done cards, or curriculum with each other. Only goals.json is stored per
profile, not config.yaml -- cli.cmd_run already prefers goals.json when present
(Option A) and derives everything else from it in memory via
config.goals_to_config(), so config.yaml would just be a redundant, driftable copy.

Optional real encryption per profile, via envelope encryption: creating a
password-protected profile generates a random per-profile data key (the thing
goals.json/state.json are actually Fernet-encrypted with), then wraps -- encrypts --
that data key twice: once under a key derived (PBKDF2-HMAC-SHA256, per-profile salt)
from the password, and once under a key derived the same way from a randomly
generated recovery code, shown to the user exactly once at creation time and never
stored anywhere. Either the password or the recovery code independently unwraps the
same data key, so forgetting the password doesn't have to mean losing the data (gh40)
-- as long as the recovery code was saved somewhere -- while mtdo itself still never
stores anything that alone can decrypt a profile without one of those two secrets
(no server-side escrow, same as before). Losing *both* the password and the recovery
code is still unrecoverable by design -- that's the honest remaining tradeoff of real
local encryption. A profile created without a password has no such risk (and no such
protection): its files are plain JSON.

The data key never changes for a profile's lifetime, so recover_profile() (reset
password via recovery code) and a hypothetical future change-password just rewrap it
under a new password-derived key -- goals.json/state.json are never re-encrypted.

This module is the data/crypto layer only -- it doesn't know about the running app's
in-memory state or which files it currently has open. See app.py's profile-switch
wiring for how an active profile's plaintext gets decrypted to the app's normal
~/.mtdo/{goals.json,state.json} working paths for the running session, and
re-encrypted back into profiles/<slug>/ on save and on switching away.
"""
import base64
import json
import os
import re
import secrets
import shutil

from . import config as appconfig

APP_DIR = appconfig.APP_DIR
PROFILES_DIR = os.path.join(APP_DIR, "profiles")
INDEX_PATH = os.path.join(PROFILES_DIR, "index.json")

_KDF_ITERATIONS = 480_000  # OWASP's 2023 minimum recommendation for PBKDF2-HMAC-SHA256


class ProfileError(Exception):
    """Base for the errors below -- callers that don't care about the distinction
    can just catch this."""


class ProfileExists(ProfileError):
    pass


class ProfileNotFound(ProfileError):
    pass


class WrongPassword(ProfileError):
    pass


class InvalidRecoveryCode(ProfileError):
    pass


def _generate_recovery_code():
    """~120 bits of entropy, base32 (no 0/1/8/9 ambiguity), grouped for readability.
    Shown to the caller exactly once at creation time -- mtdo never stores the code
    itself, only a wrapped data key that it can unwrap (see module docstring)."""
    raw = secrets.token_bytes(15)
    b32 = base64.b32encode(raw).decode("ascii").rstrip("=")
    return "-".join(b32[i:i + 4] for i in range(0, len(b32), 4))


def _normalize_recovery_code(code):
    """Tolerate however the user reproduces it -- copy-pasted with dashes, retyped
    lowercase, with stray whitespace, etc."""
    return re.sub(r"[^A-Z0-9]", "", code.strip().upper())


def _require_cryptography():
    """cryptography is a real, always-installed dependency (see pyproject.toml) --
    this just gives a clear error instead of a raw ImportError traceback in the rare
    case someone's running from a stale install that predates it."""
    try:
        from cryptography.fernet import Fernet, InvalidToken
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        return Fernet, InvalidToken, hashes, PBKDF2HMAC
    except ImportError as e:
        raise ProfileError(
            "Password-protected profiles need the 'cryptography' package -- "
            "run: pip install -e . (it's a listed dependency, this install is just stale)"
        ) from e


def _slugify(name):
    slug = re.sub(r"[^a-z0-9_]+", "_", name.strip().lower()).strip("_")
    return slug or "profile"


def _unique_slug(name):
    base = _slugify(name)
    existing = {p["slug"] for p in list_profiles()}
    if base not in existing:
        return base
    n = 2
    while f"{base}_{n}" in existing:
        n += 1
    return f"{base}_{n}"


def profile_dir(slug):
    return os.path.join(PROFILES_DIR, slug)


def _now_iso():
    import datetime
    return datetime.datetime.now().isoformat(timespec="seconds")


def _load_index():
    if not os.path.exists(INDEX_PATH):
        return {"profiles": [], "active": None}
    with open(INDEX_PATH) as f:
        return json.load(f)


def _save_index(index):
    os.makedirs(PROFILES_DIR, exist_ok=True)
    with open(INDEX_PATH, "w") as f:
        json.dump(index, f, indent=2)


def list_profiles():
    """[{slug, name, protected, created_at}, ...], creation order."""
    return _load_index().get("profiles", [])


def get_profile(slug):
    for p in list_profiles():
        if p["slug"] == slug:
            return p
    return None


def get_active_slug():
    return _load_index().get("active")


def set_active(slug):
    if not get_profile(slug):
        raise ProfileNotFound(f"no such profile: {slug}")
    index = _load_index()
    index["active"] = slug
    _save_index(index)


def clear_active():
    """Unsets the active profile without touching any profile's own data. Used by
    the test suite so a protected profile a test leaves active doesn't leak into
    the next test's app launch (see conftest.py) -- ProfileUnlockScreen (gh49)
    made active-profile state observable at TodoApp construction time in a way it
    never was before, which the shared-MTDO_HOME test session wasn't isolating
    against since only profile *names* needed to be unique before now."""
    index = _load_index()
    index["active"] = None
    _save_index(index)


def _derive_key(password, salt):
    _Fernet, _InvalidToken, hashes, PBKDF2HMAC = _require_cryptography()
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=_KDF_ITERATIONS)
    return base64.urlsafe_b64encode(kdf.derive(password.encode("utf-8")))


def create_profile(name, password=None):
    """Registers a new, empty profile (no goals.json yet -- see write_goals/
    import_goals_file/generate below for how it actually gets filled in). Returns
    (slug, recovery_code) -- recovery_code is None unless a password was given, in
    which case it's shown to the caller exactly once here and never stored; the
    caller is responsible for actually displaying it. Raises ProfileExists if the
    derived slug collides -- doesn't happen in practice since the slug
    auto-disambiguates, but two names that slugify identically (e.g. "DSA Track" and
    "dsa track") would still collide on purpose, since they'd be indistinguishable in
    the picker otherwise."""
    name = name.strip()
    if not name:
        raise ProfileError("a profile needs a name.")
    slug = _slugify(name)
    if get_profile(slug):
        raise ProfileExists(f'a profile named "{name}" already exists.')
    d = profile_dir(slug)
    os.makedirs(d, exist_ok=True)
    os.makedirs(os.path.join(d, "reports"), exist_ok=True)
    entry = {"slug": slug, "name": name, "protected": bool(password), "created_at": _now_iso()}
    recovery_code = None
    if password:
        Fernet, _InvalidToken, _hashes, _PBKDF2HMAC = _require_cryptography()
        data_key = Fernet.generate_key()

        pw_salt = os.urandom(16)
        entry["salt"] = base64.b64encode(pw_salt).decode("ascii")
        entry["wrapped_key"] = Fernet(_derive_key(password, pw_salt)).encrypt(data_key).decode("ascii")

        recovery_code = _generate_recovery_code()
        rec_salt = os.urandom(16)
        entry["recovery_salt"] = base64.b64encode(rec_salt).decode("ascii")
        rec_key = _derive_key(_normalize_recovery_code(recovery_code), rec_salt)
        entry["wrapped_key_recovery"] = Fernet(rec_key).encrypt(data_key).decode("ascii")
    index = _load_index()
    index["profiles"].append(entry)
    if index.get("active") is None:
        index["active"] = slug
    _save_index(index)
    return slug, recovery_code


def rename_profile(slug, new_name):
    """Renames a profile's display name while keeping the same slug and storage dir."""
    profile = get_profile(slug)
    if profile is None:
        raise ProfileNotFound(f"no such profile: {slug}")
    new_name = new_name.strip()
    if not new_name:
        raise ProfileError("a profile needs a name.")
    desired_slug = _slugify(new_name)
    if desired_slug != slug and get_profile(desired_slug):
        raise ProfileExists(f'a profile named "{new_name}" already exists.')
    index = _load_index()
    for entry in index["profiles"]:
        if entry["slug"] == slug:
            entry["name"] = new_name
            break
    _save_index(index)
    return new_name


def delete_profile(slug):
    if not get_profile(slug):
        raise ProfileNotFound(f"no such profile: {slug}")
    index = _load_index()
    index["profiles"] = [p for p in index["profiles"] if p["slug"] != slug]
    if index.get("active") == slug:
        index["active"] = index["profiles"][0]["slug"] if index["profiles"] else None
    _save_index(index)
    shutil.rmtree(profile_dir(slug), ignore_errors=True)


def _recovery_code_local_path(slug):
    return os.path.join(profile_dir(slug), "recovery_code.json")


def save_recovery_code_locally(slug, recovery_code, password=None):
    """Saves an optional local backup copy of a profile's recovery code (gh53) --
    purely a convenience for a user who'd rather not write it down somewhere else
    themselves; RecoveryCodeScreen offers this right after showing the code.
    Deliberately independent of the profile's own password/data-key envelope: a
    `password` here (if given) protects only this saved copy, with its own
    separate salt, using the same PBKDF2+Fernet scheme as everything else in this
    module -- gating the one thing meant to survive forgetting your password
    behind that same password would defeat the point. `password=None` saves it as
    plain, readable JSON, the same tradeoff an unprotected profile already makes.
    Lives inside the profile's own directory, so delete_profile's rmtree already
    cleans it up -- no separate teardown needed."""
    profile = get_profile(slug)
    if profile is None:
        raise ProfileNotFound(f"no such profile: {slug}")
    os.makedirs(profile_dir(slug), exist_ok=True)
    if password:
        Fernet, _InvalidToken, _hashes, _PBKDF2HMAC = _require_cryptography()
        salt = os.urandom(16)
        encrypted = Fernet(_derive_key(password, salt)).encrypt(recovery_code.encode("utf-8"))
        record = {
            "protected": True,
            "salt": base64.b64encode(salt).decode("ascii"),
            "code": encrypted.decode("ascii"),
        }
    else:
        record = {"protected": False, "code": recovery_code}
    with open(_recovery_code_local_path(slug), "w") as f:
        json.dump(record, f, indent=2)


def has_local_recovery_code(slug):
    return os.path.exists(_recovery_code_local_path(slug))


def local_recovery_code_protected(slug):
    """True only if a local recovery-code save exists AND is password-protected --
    lets a caller (e.g. the "View Recovery Code" button) decide whether to prompt
    for a password before calling read_local_recovery_code, without needing to
    attempt-and-catch as a way to probe that."""
    path = _recovery_code_local_path(slug)
    if not os.path.exists(path):
        return False
    with open(path) as f:
        return bool(json.load(f).get("protected"))


def read_local_recovery_code(slug, password=None):
    """Reads back a locally saved recovery code (gh53's counterpart to
    save_recovery_code_locally). Raises ProfileError if no local copy was ever
    saved for this profile, WrongPassword if it's protected and `password` is
    wrong."""
    path = _recovery_code_local_path(slug)
    if not os.path.exists(path):
        raise ProfileError("no locally saved recovery code for this profile.")
    with open(path) as f:
        record = json.load(f)
    if not record.get("protected"):
        return record["code"]
    Fernet, InvalidToken, _hashes, _PBKDF2HMAC = _require_cryptography()
    salt = base64.b64decode(record["salt"])
    key = _derive_key(password or "", salt)
    try:
        return Fernet(key).decrypt(record["code"].encode("ascii")).decode("utf-8")
    except InvalidToken:
        raise WrongPassword("wrong password for this saved recovery code.")


def _unwrap_data_key(profile, password):
    """The Fernet key goals.json/state.json are actually encrypted with, recovered
    by decrypting the password-wrapped copy stored in the index. Also serves as the
    password check: unwrapping IS confirming the password, no separate verifier
    token needed (unlike before gh40's envelope-encryption rework)."""
    Fernet, InvalidToken, _hashes, _PBKDF2HMAC = _require_cryptography()
    salt = base64.b64decode(profile["salt"])
    key = _derive_key(password, salt)
    try:
        return Fernet(key).decrypt(profile["wrapped_key"].encode("ascii"))
    except InvalidToken:
        raise WrongPassword(f'wrong password for profile "{profile["name"]}".')


def check_password(slug, password):
    """True if `password` is right for `slug` (or the profile isn't protected at
    all). Doesn't touch goals.json/state.json -- confirming a password only ever
    unwraps the (much smaller) stored data key."""
    profile = get_profile(slug)
    if profile is None:
        raise ProfileNotFound(f"no such profile: {slug}")
    if not profile.get("protected"):
        return True
    try:
        _unwrap_data_key(profile, password)
        return True
    except WrongPassword:
        return False


def _unwrap_data_key_via_recovery(profile, recovery_code):
    """Recovery-code counterpart to _unwrap_data_key -- same envelope, unwrapped with
    the recovery-code-derived key instead of the password-derived one."""
    Fernet, InvalidToken, _hashes, _PBKDF2HMAC = _require_cryptography()
    rec_salt = base64.b64decode(profile["recovery_salt"])
    rec_key = _derive_key(_normalize_recovery_code(recovery_code), rec_salt)
    try:
        return Fernet(rec_key).decrypt(profile["wrapped_key_recovery"].encode("ascii"))
    except InvalidToken:
        raise InvalidRecoveryCode(f'wrong recovery code for profile "{profile["name"]}".')


def check_recovery_code(slug, recovery_code):
    """True if `recovery_code` is right for `slug`. Mirrors check_password -- lets a
    caller validate the code by itself, before asking for (and confirming) a new
    password, instead of only finding out it was wrong at the very end of that flow
    (gh51: the reset itself was never actually vulnerable to a wrong code, but asking
    the user to type and confirm a new password *before* telling them the code was
    wrong reads exactly like the app "let" the change through)."""
    profile = get_profile(slug)
    if profile is None:
        raise ProfileNotFound(f"no such profile: {slug}")
    if not profile.get("protected"):
        return False
    try:
        _unwrap_data_key_via_recovery(profile, recovery_code)
        return True
    except InvalidRecoveryCode:
        return False


def recover_profile(slug, recovery_code, new_password):
    """Resets a protected profile's password using its recovery code, without
    needing (or changing) the old password -- the gh40 fix. Unwraps the data key via
    the recovery-code-derived key, then rewraps it under a fresh password-derived key
    (new random salt); goals.json/state.json are untouched, since they're encrypted
    with the data key itself, not directly with either wrapped copy. The recovery
    code keeps working afterward -- it's not single-use -- since losing a password a
    second time is just as forgivable as the first."""
    profile = get_profile(slug)
    if profile is None:
        raise ProfileNotFound(f"no such profile: {slug}")
    if not profile.get("protected"):
        raise ProfileError(f'profile "{profile["name"]}" has no password to reset.')
    new_password = (new_password or "").strip()
    if not new_password:
        raise ProfileError("a new password is required.")

    Fernet, InvalidToken, _hashes, _PBKDF2HMAC = _require_cryptography()
    data_key = _unwrap_data_key_via_recovery(profile, recovery_code)

    pw_salt = os.urandom(16)
    wrapped_key = Fernet(_derive_key(new_password, pw_salt)).encrypt(data_key).decode("ascii")

    index = _load_index()
    for entry in index["profiles"]:
        if entry["slug"] == slug:
            entry["salt"] = base64.b64encode(pw_salt).decode("ascii")
            entry["wrapped_key"] = wrapped_key
            break
    _save_index(index)


def _encrypt_for(slug, password, raw_bytes):
    profile = get_profile(slug)
    Fernet, _InvalidToken, _hashes, _PBKDF2HMAC = _require_cryptography()
    data_key = _unwrap_data_key(profile, password)
    return Fernet(data_key).encrypt(raw_bytes)


def _decrypt_for(slug, password, raw_bytes):
    profile = get_profile(slug)
    Fernet, InvalidToken, _hashes, _PBKDF2HMAC = _require_cryptography()
    data_key = _unwrap_data_key(profile, password)
    try:
        return Fernet(data_key).decrypt(raw_bytes)
    except InvalidToken:
        raise WrongPassword(f'wrong password for profile "{profile["name"]}".')


def _goals_path(slug):
    return os.path.join(profile_dir(slug), "goals.json")


def _state_path(slug):
    return os.path.join(profile_dir(slug), "state.json")


def read_goals(slug, password=None):
    """Parsed goals.json for this profile, or None if it hasn't been written yet
    (a freshly created profile with nothing filled in)."""
    profile = get_profile(slug)
    if profile is None:
        raise ProfileNotFound(f"no such profile: {slug}")
    path = _goals_path(slug)
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        raw = f.read()
    if profile.get("protected"):
        raw = _decrypt_for(slug, password, raw)
    return json.loads(raw)


def write_goals(slug, goals, password=None):
    profile = get_profile(slug)
    if profile is None:
        raise ProfileNotFound(f"no such profile: {slug}")
    raw = json.dumps(goals, indent=2).encode("utf-8")
    if profile.get("protected"):
        raw = _encrypt_for(slug, password, raw)
    with open(_goals_path(slug), "wb") as f:
        f.write(raw)


def read_state(slug, password=None):
    """Parsed state.json for this profile, or {} if it hasn't been written yet (a
    brand new profile with no tracked days)."""
    profile = get_profile(slug)
    if profile is None:
        raise ProfileNotFound(f"no such profile: {slug}")
    path = _state_path(slug)
    if not os.path.exists(path):
        return {}
    with open(path, "rb") as f:
        raw = f.read()
    if profile.get("protected"):
        raw = _decrypt_for(slug, password, raw)
    return json.loads(raw)


def write_state(slug, state, password=None):
    profile = get_profile(slug)
    if profile is None:
        raise ProfileNotFound(f"no such profile: {slug}")
    raw = json.dumps(state, indent=2).encode("utf-8")
    if profile.get("protected"):
        raw = _encrypt_for(slug, password, raw)
    with open(_state_path(slug), "wb") as f:
        f.write(raw)


def import_goals_file(slug, source_path, password=None):
    """Copies an existing external goals.json (given as a plain file path, e.g. one
    exported from another machine or written by hand) into this profile. Validates
    it's actually parseable JSON before accepting it -- a bad path or a non-JSON file
    fails loudly here instead of corrupting the profile silently."""
    source_path = os.path.expanduser(source_path.strip().strip('"').strip("'"))
    if not os.path.isfile(source_path):
        raise ProfileError(f"no file at {source_path}")
    with open(source_path) as f:
        try:
            goals = json.load(f)
        except json.JSONDecodeError as e:
            raise ProfileError(f"{source_path} isn't valid JSON: {e}") from e
    write_goals(slug, goals, password)
    return goals


def reports_dir(slug):
    return os.path.join(profile_dir(slug), "reports")
