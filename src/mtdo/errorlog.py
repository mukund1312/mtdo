"""Single error/crash log for the whole app, at ~/.mtdo/error.log -- so recording a
crash is one import + one call away from any module, and "what went wrong" always
lives in one predictable place instead of scattering across print() calls that vanish
the moment the TUI's alternate screen buffer closes.
"""
import logging
import os

from . import config as appconfig

LOG_DIR = appconfig.APP_DIR
LOG_PATH = os.path.join(LOG_DIR, "error.log")


def _build_logger():
    logger = logging.getLogger("mtdo")
    if not logger.handlers:
        os.makedirs(LOG_DIR, exist_ok=True)
        handler = logging.FileHandler(LOG_PATH)
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
        logger.propagate = False
    return logger


log = _build_logger()
