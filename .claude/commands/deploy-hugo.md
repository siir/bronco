---
description: Build and deploy the control panel to Hugo for live preview
allowed-tools: Bash(cd *), Bash(npx ng build *), Bash(tar *), Bash(scp *), Bash(ssh *), Bash(rm *)
---

## Your task

Build the control panel and deploy the static files to the Hugo server for live preview.

## Steps

1. Determine which directory has the control panel source. Check if you're in a worktree (look for `services/control-panel` relative to the current working directory or any known worktree path). If unsure, use the main repo at `/Users/chad/Source Code/siir/bronco`.

2. Build the Angular app:
   ```
   cd "<repo-root>/services/control-panel" && npx ng build --configuration production
   ```

3. Create a tarball of the build output:
   ```
   tar -czf /tmp/control-panel-dist.tar.gz -C "<repo-root>/services/control-panel/dist/control-panel/browser" .
   ```

4. Copy the tarball to Hugo:
   ```
   scp /tmp/control-panel-dist.tar.gz hugo-app:/tmp/control-panel-dist.tar.gz
   ```

5. Clear old files and extract new ones in the Caddy container:
   ```
   ssh hugo-app "docker exec bronco-caddy-1 rm -rf /srv/control-panel/*"
   ssh hugo-app "docker cp /tmp/control-panel-dist.tar.gz bronco-caddy-1:/tmp/"
   ssh hugo-app "docker exec bronco-caddy-1 sh -c 'cd /srv/control-panel && tar -xzf /tmp/control-panel-dist.tar.gz && rm /tmp/control-panel-dist.tar.gz'"
   ```

6. Verify the deploy:
   ```
   ssh hugo-app "docker exec bronco-caddy-1 ls /srv/control-panel/index.html"
   ```

7. Clean up:
   ```
   rm /tmp/control-panel-dist.tar.gz
   ```

Report success with a brief message. This is a hot-deploy into the running container — it will be overwritten by the next full release deploy, so there is no risk to the CI/CD pipeline.
