"""Baseline smoke tests -- the minimum a CI run should catch: the package
imports cleanly, and the app actually mounts and reaches its normal board
screen without raising, using the real sandbox-style flow (fresh MTDO_HOME,
first-run prompts included) rather than any mocked-out shortcut.
"""
from mtdo.app import KanbanBoard, TextPromptScreen, TodoApp


def test_package_imports():
    import mtdo
    assert mtdo.__version__


async def test_app_mounts_and_reaches_board():
    app = TodoApp()
    async with app.run_test() as pilot:
        await pilot.pause()
        if isinstance(app.screen, TextPromptScreen):
            for ch in "TestUser":
                await pilot.press(ch)
            await pilot.press("enter")
            await pilot.pause()
        await pilot.press("escape")
        await pilot.pause()
        assert app.query_one(KanbanBoard) is not None
