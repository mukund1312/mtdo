# GitHub Sync Workflow

**Goal:** Keep your local mtdo system in perfect sync with GitHub. Any changes → Push → Pull.

## 🔄 Standard Workflow (Every Time)

### 1️⃣ **Make Changes**
```bash
# Edit code, config, etc.
# Example:
vim src/mtdo/config.py
```

### 2️⃣ **Check Status**
```bash
git status                    # See what changed
git diff src/mtdo/config.py   # Review changes before committing
```

### 3️⃣ **Stage & Commit**
```bash
git add src/mtdo/config.py    # Stage specific files (not git add .)
git commit -m "Brief description of what changed"
```

**Good commit message format:**
```
feat: add new feature
fix: resolve a bug  
refactor: reorganize code
docs: update documentation

Keep it under 50 chars, then details below if needed
```

### 4️⃣ **Push to GitHub**
```bash
git push origin main
```

### 5️⃣ **Pull to Verify Sync**
```bash
git pull origin main          # Bring latest back locally
git log --oneline -3          # Verify your commit is there
```

---

## 📋 Quick Reference

```bash
# One-liner for the whole flow:
git add <files> && git commit -m "message" && git push origin main && git pull origin main

# Or use this alias (add to ~/.zshrc):
alias gps='git add . && git commit -m "update" && git push origin main && git pull origin main'
```

---

## 🛡️ Safety Checks

Before committing, **always**:

```bash
git status                    # ✓ See what you're committing
git diff                      # ✓ Review actual changes
git log --oneline -3          # ✓ See recent commits
```

**Before pushing:**
```bash
git push origin main --dry-run  # Preview what would push (optional)
```

---

## 📍 Current State

**GitHub Repo:** `https://github.com/mukund1312/mtdo`
**Branch:** `main`
**Last Commit:** `feat: implement Option A (JSON-driven mode) with auto-snapshots`

---

## ✅ Commands You'll Use Most

| Task | Command |
|------|---------|
| See what changed | `git status` |
| Review changes | `git diff` |
| Stage files | `git add <file>` |
| Commit | `git commit -m "message"` |
| Push to GitHub | `git push origin main` |
| Pull latest | `git pull origin main` |
| See recent commits | `git log --oneline -5` |
| Undo last commit (if not pushed) | `git reset --soft HEAD~1` |

---

## ⚠️ Important Rules

✅ **DO:**
- Commit frequently (small, focused changes)
- Write clear commit messages
- Push regularly to GitHub
- Pull before starting new work
- Review changes before committing

❌ **DON'T:**
- Use `git add .` (adds everything, might include unwanted files)
- Commit without reviewing changes
- Forget to push (keep GitHub updated)
- Force push without asking
- Leave uncommitted changes for days

---

## 🔗 Making It a Habit

### Setup (One Time)

Add this to `~/.zshrc` for quick access:

```bash
# MTDO git helpers
alias mtdo-status='cd /Users/mukundumashankar/mtdo && git status'
alias mtdo-diff='cd /Users/mukundumashankar/mtdo && git diff'
alias mtdo-log='cd /Users/mukundumashankar/mtdo && git log --oneline -10'
alias mtdo-push='cd /Users/mukundumashankar/mtdo && git push origin main && git pull origin main'
alias mtdo-commit='cd /Users/mukundumashankar/mtdo && git add -A && git commit'
```

Then reload:
```bash
source ~/.zshrc
```

### After Each Session

```bash
mtdo-status                  # Check what's uncommitted
mtdo-push                    # Push & pull everything
mtdo-log                     # Verify it's on GitHub
```

---

## 📊 Example Session

```bash
# 1. Make changes
vim src/mtdo/cli.py
vim src/mtdo/config.py

# 2. Check status
mtdo-status
# Output:
# modified:   src/mtdo/cli.py
# modified:   src/mtdo/config.py

# 3. Review changes
mtdo-diff                    # See exactly what changed

# 4. Stage & commit
git add src/mtdo/cli.py src/mtdo/config.py
git commit -m "feat: add new snapshot commands"

# 5. Push & pull
mtdo-push
# Output:
# Pushing to https://github.com/mukund1312/mtdo.git
# To https://github.com/mukund1312/mtdo.git
#    abc1234..def5678  main -> main
# ✓ Already up to date.

# 6. Verify
mtdo-log
# Output:
# def5678 feat: add new snapshot commands
# abc1234 feat: implement Option A
```

---

## 🚨 If Something Goes Wrong

**"I pushed something wrong"**
```bash
git log --oneline -5          # Find the commit
git show abc1234              # Review what's in it
# If not merged yet: contact and we can force-revert
```

**"I have uncommitted changes and want to start fresh"**
```bash
git status                    # See what's uncommitted
git diff                      # Review before discarding
git checkout -- .             # Discard all changes
git pull origin main          # Get latest from GitHub
```

**"I want to undo my last commit (before push)"**
```bash
git reset --soft HEAD~1       # Undo commit, keep changes
git add                       # Re-stage what you want
git commit                    # Commit again
```

---

## 📝 Checklist Before Push

- [ ] Tested changes locally
- [ ] Reviewed `git diff`
- [ ] Committed with clear message
- [ ] No sensitive data in commit (no passwords, keys, tokens)
- [ ] Ready to push to public GitHub

---

## 🎯 The Golden Rule

**Before you close Claude Code or end your session:**

```bash
git status                    # Any uncommitted changes?
if [ $? -ne 0 ]; then
  git add <files>
  git commit -m "message"
  git push origin main
fi
```

**Result:** Your GitHub is always up-to-date, your local is always synced! 🚀
