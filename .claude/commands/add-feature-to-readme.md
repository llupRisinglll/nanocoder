# Add Feature to README

Use this skill when adding a new feature to the nanocoder fork and you want to document it in the README.

## Steps

1. **Add entry to checklist** in `README.md` under "Custom Features (Fork Additions)":
   ```markdown
   - [ ] Feature name with brief description (`example/command`)
   ```

2. **Add screenshot** (if visual) to `docs/` folder with descriptive name:
   ```bash
   cp /tmp/screenshot.png docs/feature-name.png
   ```

3. **Add documentation section** after the checklist (if the feature needs explanation):
   ```markdown
   ### Feature Name
   
   Description of what the feature does.
   
   ![Feature Name](docs/feature-name.png)
   ```

4. **Commit separately** for easy contribution:
   ```bash
   git add README.md docs/feature-name.png
   git commit -m "docs: add feature-name to README"
   ```

## Checklist Entry Format

- Use `- [ ]` (not done in original repo) or `- [x]` (already contributed)
- Keep description concise (one line)
- Include example command/code if relevant
- Group related items (e.g., status line features)

## Example

```markdown
- [ ] Status line position control (`/statusline position top|bottom`) + `/settings` integration
- [ ] Working indicator with animated gear and timer (`⚙ Working... (12s)`)
- [x] Multiline cursor navigation and word-jump fixes
```
