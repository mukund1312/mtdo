"""mtdo's config module reads MTDO_HOME into a module-level constant
(config.APP_DIR) at import time -- see config.py's own comment on that. That
means MTDO_HOME has to be set, and pointed at a scratch directory, before
`mtdo` is imported anywhere, by anything, in this process. pytest always
imports a directory's conftest.py before collecting/importing test modules
in that directory, which is what makes this safe to do here at module level
rather than inside a fixture.

Tests share one MTDO_HOME for the whole session (real ~/.mtdo is never
touched) -- each test creates its own uniquely-named profile rather than
getting a fully separate MTDO_HOME, so tests don't need per-test teardown to
avoid colliding with each other on profile *names*. The active profile
pointer is a separate piece of shared state that name-uniqueness doesn't
cover, though -- ProfileUnlockScreen (gh49) made a protected active profile
observable at the very next TodoApp() construction (it blocks app launch),
so _clear_active_profile below resets it after every test regardless of
whether that test used one.
"""
import os
import shutil
import sys
import tempfile

_TEST_HOME = tempfile.mkdtemp(prefix="mtdo-pytest-")
os.environ["MTDO_HOME"] = _TEST_HOME

_SRC = os.path.join(os.path.dirname(__file__), "..", "src")
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)

# mark first-run onboarding done so it never intercepts a test
open(os.path.join(_TEST_HOME, "onboarded"), "w").close()

import pytest


@pytest.fixture(scope="session", autouse=True)
def _cleanup_test_home():
    yield
    shutil.rmtree(_TEST_HOME, ignore_errors=True)


@pytest.fixture(autouse=True)
def _clear_active_profile():
    yield
    from mtdo import profiles as pf
    pf.clear_active()


@pytest.fixture
def unique_slug(request):
    """A profile name unique to the running test, so parallel/repeated runs
    within the shared session MTDO_HOME never collide on an existing slug."""
    return f"test_{request.node.name}".replace("[", "_").replace("]", "")[:40]
