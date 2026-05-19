#!/usr/bin/env node
/**
 * Post-install hook for opencli-plugin-flow.
 *
 * `opencli plugin install …` runs `npm install` inside the plugin dir, which
 * triggers this script. We use it to wire the bundled SKILL.md into the
 * locations Claude Code (and similar tools) actually scan:
 *
 *   ~/.claude/skills/flow/        ← symlinked
 *
 * The plugin's own source-of-truth stays at ./skills/flow/SKILL.md so it
 * versions and ships with the plugin.
 */
import { existsSync, mkdirSync, lstatSync, unlinkSync, symlinkSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const log = (msg) => process.stderr.write(`${msg}\n`);
const here = dirname(fileURLToPath(import.meta.url));
const skillSrc = resolve(here, 'skills', 'flow');

if (!existsSync(skillSrc)) {
  log('flow plugin: no skills/flow directory found, skipping skill registration');
  process.exit(0);
}

const targetParent = join(homedir(), '.claude', 'skills');
const target = join(targetParent, 'flow');

try {
  mkdirSync(targetParent, { recursive: true });

  // If something already exists at the target, remove it cleanly:
  //   - symlink (broken or live) → unlink
  //   - regular file/dir → rm -rf  (user can re-run install to refresh)
  if (existsSync(target) || (() => { try { lstatSync(target); return true; } catch { return false; } })()) {
    try {
      const st = lstatSync(target);
      if (st.isSymbolicLink()) unlinkSync(target);
      else rmSync(target, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  // Use symlink so updating the plugin (via `opencli plugin update flow`)
  // also refreshes the skill content automatically. Windows often requires
  // admin rights for symlinks, so fall back to junction there.
  const linkType = platform() === 'win32' ? 'junction' : 'dir';
  symlinkSync(skillSrc, target, linkType);
  log(`\x1b[32m✓\x1b[0m Linked flow skill → ${target}`);
} catch (err) {
  // Don't fail the whole install if we can't write to ~/.claude — the plugin
  // commands still work, the user just won't get the Claude Code skill.
  log(`\x1b[33m!\x1b[0m Could not link skill to ${target}: ${err.message}`);
  log('  Plugin commands still work, but Claude Code will not auto-discover the skill.');
  log('  Manual fix:  ln -s "' + skillSrc + '" "' + target + '"');
}
