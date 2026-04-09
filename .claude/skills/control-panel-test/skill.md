---
name: control-panel-test
description: "Test a branch locally — kills existing dev servers, pulls the branch, proxies API to Hugo, and launches the control panel with hot reload. Triggers on: control panel test, test control panel, preview branch, design test."
---

# Control Panel Test Session

Launch the control panel dev server locally against Hugo's backend to test UI changes.

## Usage

```
/control-panel-test <branch-name>
```

If no branch name is provided, ask the user which branch to test.

## Steps

1. **Kill anything already running on port 4200**

```bash
lsof -ti :4200 | xargs kill 2>/dev/null || true
```

Also check for stray `ng serve` processes:

```bash
pkill -f "ng serve" 2>/dev/null || true
```

2. **Fetch and checkout the branch**

```bash
git -C "/Users/chad/Source Code/siir/bronco" fetch origin
git -C "/Users/chad/Source Code/siir/bronco" checkout <branch-name>
git -C "/Users/chad/Source Code/siir/bronco" pull origin <branch-name>
```

3. **Ensure the Hugo proxy config exists**

Write `services/control-panel/proxy.conf.hugo.json` if it doesn't already exist (this file is gitignored):

```json
{
  "/api": {
    "target": "https://hugo.taila1bf6b.ts.net",
    "secure": false,
    "changeOrigin": true
  }
}
```

4. **Install dependencies**

```bash
cd "/Users/chad/Source Code/siir/bronco"
pnpm install
```

5. **Start the dev server (in background)**

```bash
cd "/Users/chad/Source Code/siir/bronco/services/control-panel"
npx ng serve --proxy-config proxy.conf.hugo.json --open
```

Run this in the background so the conversation stays interactive. Wait ~15 seconds then read the output to confirm the build succeeded.

6. **Report to the user**

Tell the user:
- **Branch**: `<branch-name>`
- **Working directory**: `/Users/chad/Source Code/siir/bronco`
- **URL**: http://localhost:4200/cp/
- **API proxied to**: Hugo (https://hugo.taila1bf6b.ts.net)
- Hot reload is active — file saves in the working directory reflect instantly
- If another session is making changes, they must edit files in this same directory on this branch for hot reload to pick them up

## When Done

When the user is done testing, kill the dev server:

```bash
pkill -f "ng serve"
```

Remind them that `proxy.conf.hugo.json` is a local artifact — do not commit it.

## Do NOT

- Commit any changes
- Switch branches without asking
- Modify any source files
- Push anything
